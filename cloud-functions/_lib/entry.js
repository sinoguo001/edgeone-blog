// ============================================================
// 全站请求分发器（入口的**实现**，作为辅助模块放在 _lib/ 下）
// 负责：/api/* 接口、/media/* 图片代理（Blob 存储）、前台页面 SSR、
//       rss.xml / sitemap.xml / robots.txt
// 说明：后台与静态资源不经过这里 —— EdgeOne 的路由优先级是
//       「静态资源 > 函数」，public/ 下的文件由平台直接命中。
//
// ★ 为什么实现放在 _lib/ 而不是直接写在入口文件里（2026-09-18 踩坑）：
//   平台的 Node 函数构建器会把「入口文件」打包进同一个作用域。入口文件之间
//   互相 import 时，两边同名的 onRequest 会撞在一起，构建直接失败：
//     ERROR: The symbol "onRequest" has already been declared
//   官方约定：只有导出了 Handler（onRequest / onRequestGet…）的文件才算入口，
//   其余 .js 一律是「辅助模块」，会被复制进产物供入口引用。
//   所以：实现放这里，入口只有薄薄一层转发 ——
//     cloud-functions/[[default]].js  → 一段或多段路径（catch-all）
//     cloud-functions/index.js        → 站点根 `/`（catch-all 不匹配零段）
//   两个入口互不引用，逻辑也只有一份，不会各改各的。
// ============================================================
import { json, err, esc, bnNow, readJson, mimeOfExt, isHexColor, isEmail, stripHtml, wantsFeedHtml, readCookie, bgTask,
  normalizePermalink, permalinkOf, permalinkRegex, postUrl, pageUrl, catUrl, permalinkVarsMatch } from './util.js';
// EdgeOne Makers 适配层：平台没有 D1 / R2 / cloudflare:sockets，
// 这里统一换成 Blob 存储（对象存储 + 文档库）与 Node net/tls 的等价实现。
import { resolveEnv } from './store/index.js';
// connect 必须是**顶层静态导入**，再由这里显式注入给 mail.js（契约与 cloudflare:sockets
// 完全一致，所以 SMTP 协议流程 EHLO / STARTTLS / AUTH / DATA 一行都不用改）：
//   ① mail.js 自己不能 import net.js —— 否则本地测试加载邮件模块时就被拖进真实网络栈，
//      没法注入假 socket 做命令级断言；
//   ② 动态 import 会让打包器难以静态分析依赖，容易出现「本地能跑、线上找不到模块」。
import { connect } from './store/net.js';
import { render } from './md.js';
import { mailConfigFrom, mailConfigError, renderMail, sendMailWithTimeout, describeCfg, mailPortIssue } from './mail.js';
import { CODE_THEMES } from './hl.js';
import * as db from './db.js';
import * as site from './site.js';
import { ADMIN_SHELL } from './admin-shell.js';
import { newSalt, pbkdf2, userFromRequest, makeSessionValue, setSessionCookie, clearSessionCookie } from './auth.js';
import { newCaptcha, checkCaptcha, clearCaptchaCookie } from './captcha.js';

// 携带 Set-Cookie 的 JSON 响应
const jset = (data, cookie, status = 200) => {
  const r = json(data, status);
  if (cookie) r.headers.set('Set-Cookie', cookie);
  return r;
};

export async function handleRequest(ctx) {
  try {
    return await handle(ctx);
  } catch (e) {
    console.error('route error:', e);
    return err('服务器内部错误：' + e.message, 500);
  }
}

async function handle(ctx) {
  const { request } = ctx;
  // 环境装配：EdgeOne 的环境变量 + Blob 存储 → 原代码认识的 env（含 DB / BLOG）。
  // 这里建好的 env 会一路传给 api() / front()，同一请求内复用同一个 DocDb 实例，
  // 它的请求级读缓存才有意义（重复 resolveEnv 会各建一份，白读几次 Blob）。
  const env = resolveEnv(ctx.env);
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const seg = decodeURIComponent(path).split('/').filter(Boolean); // 去掉首空段

  // ---- API ----
  if (seg[0] === 'api') return api(ctx, url, seg.slice(1), method, env);

  // ---- 后台静态资源 ----
  // EdgeOne 的路由优先级是「静态资源 > 函数」：public/ 下的实体文件
  // （/admin/index.html、/admin/css/app.css、/js/site.js 等）由平台直接命中，
  // 压根不会进到这里。能进函数的只剩「目录请求」这一类，补一次 302 交给静态层。
  if (seg[0] === 'admin') {
    if (seg.length === 1) {
      const target = new URL(request.url);
      target.pathname = '/admin/';
      return Response.redirect(target.toString(), 302);
    }
    // 静态层已经处理过真实存在的文件，走到这里说明该资源不存在
    return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }

  // ---- R2 图片代理 ----
  if (seg[0] === 'media') {
    if (method !== 'GET' && method !== 'HEAD') return err('方法不允许', 405);
    const key = 'media/' + seg.slice(1).join('/');
    const obj = await env.BLOG.get(key);
    if (!obj) return err('图片不存在', 404);
    const ct = obj.httpMetadata?.contentType || obj.customMetadata?.ct || mimeOfExt(key);
    return new Response(obj.body, {
      headers: {
        'content-type': ct,
        'cache-control': 'public, max-age=31536000, immutable',
        'etag': obj.httpEtag || '',
      },
    });
  }

  // ---- 主题静态资源代理（R2 themes/ 前缀；CSS 内的相对 url() 也走这里） ----
  if (seg[0] === 'theme-assets') {
    if (method !== 'GET' && method !== 'HEAD') return err('方法不允许', 405);
    const rel = seg.slice(1);
    if (!rel.length || rel.some((x) => x === '..' || x === '.' || x.includes('\\'))) return err('非法路径', 400);
    const key = 'themes/' + rel.join('/');
    const obj = await env.BLOG.get(key);
    if (!obj) return err('资源不存在', 404);
    const ct = obj.httpMetadata?.contentType || obj.customMetadata?.ct || mimeOfExt(key);
    return new Response(obj.body, {
      headers: {
        'content-type': ct,
        'cache-control': 'public, max-age=300',
        'etag': obj.httpEtag || '',
      },
    });
  }

  // ---- robots / rss / sitemap ----
  // RSS / Sitemap 双形态：
  // - 浏览器直接打开（Accept 带 text/html 且 UA 为浏览器）→ 返回排版好的 HTML 页（rssHtml/sitemapHtml）；
  // - RSS 阅读器 / 搜索引擎 → 返回标准 XML（rssXml/sitemapXml）。
  // ?format=xml|html 可强制指定，作为逃生舱（个别抓取器若误判可用）。
  if (path === '/robots.txt') {
    return new Response(site.robotsTxt(url.origin), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  // 动态 favicon：与页头 logo 同源（同字同色），改站点名或主题色自动跟随；
  // 后台若上传了自定义 favicon / logo，页面 link 会直接指向图片，不再走这里。
  if (path === '/favicon.svg') {
    const s = await db.settingsMap(env.DB);
    return new Response(site.faviconSvg(s), {
      headers: { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=3600' },
    });
  }
  // 判别函数见 util.wantsFeedHtml（浏览器 Accept 普遍含 application/xml，不能用它反推阅读器）
  const fmt = url.searchParams.get('format');
  const wantHtml = wantsFeedHtml(request.headers.get('accept'), request.headers.get('user-agent'), fmt);
  // Vary 必须带：否则 CDN 可能把给浏览器的 HTML 缓存后返回给阅读器。
  // 不设 max-age：若 CDN 的缓存 key 忽略 query，缓存了 HTML 后 ?format=xml 也会命中它。
  const feedHdr = (type) => ({ 'content-type': type, 'vary': 'Accept, User-Agent' });
  if (path === '/rss.xml' || path === '/feed.xml') {
    const s = await db.settingsMap(env.DB);
    if (wantHtml) return new Response(await site.rssHtml(env, s, url.origin), { headers: feedHdr('text/html; charset=utf-8') });
    return new Response(await site.rssXml(env, s, url.origin), { headers: feedHdr('application/rss+xml; charset=utf-8') });
  }
  if (path === '/sitemap.xml') {
    const s = await db.settingsMap(env.DB);
    if (wantHtml) return new Response(await site.sitemapHtml(env, s, url.origin), { headers: feedHdr('text/html; charset=utf-8') });
    return new Response(await site.sitemapXml(env, s, url.origin), { headers: feedHdr('application/xml; charset=utf-8') });
  }

  // ---- 其余全部交给前台渲染 ----
  return front(ctx, url, seg, method, path, env);
}

// ============ 前台页面 ============
const html = (str, status = 200) =>
  new Response(str, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

async function front(ctx, url, seg, method, path, envIn) {
  // 已装配好的 env 由 handle 传入（同一请求复用同一个 DocDb 与其读缓存）；
  // 单独调用时（本地测试等）兜底自己装配一次。
  const env = envIn || resolveEnv(ctx.env);
  const s = await db.settingsMap(env.DB);
  // 导航里的独立页面：按请求单独查好塞进 s（s 是本请求新建的 Map，不会串到别的请求），
  // layout() 再从 s 里取，避免用模块级全局变量导致并发请求互相覆盖。
  const navPages = await db.listPages(env.DB, { status: 'published', inNav: true });
  s.set('_nav_pages', JSON.stringify(navPages.map((p) => ({ title: p.title, slug: p.slug }))));
  // 导航里的分类：只取勾了「在导航栏显示」的顶级分类，二级分类跟随父项在下拉里出现
  const navCats = await db.navCategories(env.DB).catch(() => []);
  s.set('_nav_cats', JSON.stringify(navCats.map((c) => ({
    name: c.name, slug: c.slug, full_slug: c.full_slug,
    children: (c.children || []).map((k) => ({ name: k.name, slug: k.slug, full_slug: k.full_slug })),
  }))));
  const per = Math.min(20, Math.max(1, parseInt(s.get('per_page'), 10) || 8));
  const user = await userFromRequest(env, ctx.request);
  const pageNum = (p) => Math.max(1, parseInt(p, 10) || 1);

  // 首页 / /page/n
  if (seg.length === 0 || (seg.length === 2 && seg[0] === 'page')) {
    const page = seg.length === 2 ? pageNum(seg[1]) : 1;
    const data = await db.listPosts(env.DB, { status: 'published', page, per });
    data.categories = await db.listCategories(env.DB);
    return html(site.renderHome(s, data, page));
  }

  // 分类 /category · /category/别名 · /category/父别名/子别名（后两者可再跟 /page/n）
  if (seg[0] === 'category') {
    const cats = await db.listCategories(env.DB);
    if (!seg[1]) {
      // 全部分类：按父子重排，二级分类排在上级之后
      const cards = db.treeCategories(cats).map((c) => `<div class="cat-card${c.parent_id ? ' cat-card-sub' : ''}">
        <h3><a href="${esc(catUrl(c))}">${c.parent_id ? '<i class="sub-mark">└</i>' : ''}${esc(c.name)}</a></h3>
        ${c.description ? `<p>${esc(c.description)}</p>` : ''}<span class="cnt">${c.count || 0} 篇文章</span></div>`).join('');
      return html(site.renderListPage(s, { head: '全部分类', active: 'cat', title: '分类',
        itemsHtml: '', empty: '还没有分类', extra: cards ? `<div class="cat-grid">${cards}</div>` : '' }));
    }
    // 先摘掉尾部的 /page/n，剩下的都是分类路径段
    let page = 1;
    const parts = [];
    for (let i = 1; i < seg.length; i++) {
      if (seg[i] === 'page') { page = pageNum(seg[i + 1]); break; }
      parts.push(seg[i]);
    }
    // 别名全站唯一，用最后一段就能定位到分类
    const cat = cats.find((c) => c.slug === (parts[parts.length - 1] || ''));
    if (!cat) return html(site.render404(s), 404);
    // 层级不对就 301：父分类改了别名、子分类被当顶级访问、顶级分类多写了一层，全都跳到规范地址
    const want = catUrl(cat);
    if ('/category/' + parts.join('/') !== want) return redirect301(want + (page > 1 ? `/page/${page}` : ''));
    const data = await db.listPosts(env.DB, { status: 'published', cat: cat.slug, page, per });
    const itemsHtml = data.items.map((p) => {
      const u = esc(postUrl(s, p));   // 永久链接：随「文章设置」里的规则变化
      const cover = p.cover_key ? `<div class="pc-cover"><a href="${u}"><img src="/media/${esc(p.cover_key)}" alt="" loading="lazy"></a></div>` : '';
      const tags = (p.tags || []).map((t) => `<a class="tag-chip" href="/tag/${esc(t.slug)}">${esc(t.name)}</a>`).join('');
      return `<article class="pc${cover ? '' : ' no-cover'}"><div>
        <div class="pc-meta"><time>${esc(p.published_at || '').slice(0, 10)}</time></div>
        <h2 class="pc-title"><a href="${u}">${esc(p.title)}</a></h2>
        ${p.excerpt ? `<p class="pc-excerpt">${esc(p.excerpt)}</p>` : ''}
        ${tags ? `<div class="pc-tags">${tags}</div>` : ''}</div>${cover}</article>`;
    }).join('');
    // 顶级分类页顶上列出它的二级分类入口；二级分类页则给出返回上级的链接
    const kids = cats.filter((c) => Number(c.parent_id) === Number(cat.id));
    const subNav = kids.length
      ? `<div class="chips">${kids.map((c) => `<a class="chip chip-sub" href="${esc(catUrl(c))}"><i class="sub-mark">└</i>${esc(c.name)}<b> ${c.count || 0}</b></a>`).join('')}</div>`
      : (cat.parent_id ? `<p class="desc">上级分类：<a href="/category/${esc(cat.parent_slug)}">${esc(cat.parent_name || cat.parent_slug)}</a></p>` : '');
    const headName = cat.parent_id ? `${cat.parent_name || cat.parent_slug} / ${cat.name}` : cat.name;
    const makeUrl = (n) => (n <= 1 ? want : `${want}/page/${n}`);
    return html(site.renderListPage(s, {
      // active 用 c:<别名>：导航里对应的分类项（含二级）才能高亮
      head: `分类：${headName}`, active: 'c:' + cat.slug, title: cat.name,
      desc: cat.description || '', extra: subNav,
      itemsHtml, empty: '该分类下暂无文章', page, pages: data.pages, makeUrl,
    }));
  }

  // 标签 /tag /tag/x[/page/n]
  if (seg[0] === 'tag') {
    if (!seg[1]) {
      const tags = await db.listTags(env.DB);
      const cloud = tags.map((t) => `<a class="tag-pill" href="/tag/${esc(t.slug)}">${esc(t.name)}<b> ${t.count || 0}</b></a>`).join('');
      return html(site.renderListPage(s, { head: '全部标签', active: 'tags', title: '标签',
        itemsHtml: '', empty: '还没有标签', extra: `<div class="tags-cloud">${cloud}</div>` }));
    }
    const slug = seg[1];
    let page = 1;
    if (seg[2] === 'page' && seg[3]) page = pageNum(seg[3]);
    const tags = await db.listTags(env.DB);
    const tag = tags.find((t) => t.slug === slug);
    if (!tag) return html(site.render404(s), 404);
    const data = await db.listPosts(env.DB, { status: 'published', tag: slug, page, per });
    const itemsHtml = data.items.map((p) => `<article class="pc no-cover"><div>
      <div class="pc-meta"><time>${esc(p.published_at || '').slice(0, 10)}</time></div>
      <h2 class="pc-title"><a href="${esc(postUrl(s, p))}">${esc(p.title)}</a></h2></div></article>`).join('');
    const makeUrl = (n) => (n <= 1 ? `/tag/${slug}` : `/tag/${slug}/page/${n}`);
    return html(site.renderListPage(s, {
      head: `标签：${tag.name}`, active: 'tags', title: tag.name, desc: `共 ${data.total} 篇相关文章`,
      itemsHtml, empty: '该标签下暂无文章', page, pages: data.pages, makeUrl,
    }));
  }

  // 归档
  if (seg[0] === 'archive' && seg.length === 1) {
    const posts = await db.archivePosts(env.DB);
    return html(site.renderListPage(s, {
      head: '文章归档', active: 'arc', title: '归档',
      itemsHtml: '', empty: '还没有发布文章', extra: site.archiveContent(s, posts),
    }));
  }

  // 友情链接 /links：已通过的友链 + 读者申请表单
  if (seg[0] === 'links' && seg.length === 1) {
    // 建表失败（极端情况）也不能让页面 500，退化成空列表
    const links = await db.listLinks(env.DB, { status: 'approved' }).catch(() => []);
    return html(site.renderLinks(s, { links, captcha: s.get('captcha') !== '0' }));
  }

  // 分类总览 /categories、标签总览 /tags（导航栏指向这两个地址，此前缺失导致 404）
  if ((seg[0] === 'categories' || seg[0] === 'tags') && seg.length === 1) {
    const isCat = seg[0] === 'categories';
    const list = isCat ? await db.listCategories(env.DB) : await db.listTags(env.DB);
    return html(isCat ? site.renderCategories(s, list) : site.renderTags(s, list));
  }

  // 搜索
  if (seg[0] === 'search' && seg.length === 1) {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
    let itemsHtml = '', total = 0;
    if (q) {
      const data = await db.listPosts(env.DB, { status: 'published', q, per: 20 });
      total = data.total;
      itemsHtml = data.items.map((p) => `<article class="pc no-cover"><div>
        <div class="pc-meta"><time>${esc(p.published_at || '').slice(0, 10)}</time></div>
        <h2 class="pc-title"><a href="${esc(postUrl(s, p))}">${esc(p.title)}</a></h2>
        ${p.excerpt ? `<p class="pc-excerpt">${esc(p.excerpt)}</p>` : ''}</div></article>`).join('');
    }
    return html(site.renderListPage(s, {
      head: q ? `“${esc(q)}” 的搜索结果` : '搜索', active: '', title: '搜索', q,
      desc: q ? `共找到 ${total} 篇文章` : '输入关键词搜索文章标题与摘要',
      itemsHtml, empty: q ? '没有找到相关文章' : '请输入搜索词', makeUrl: () => '',
    }));
  }

  // 独立页面 /p/<slug>（Ver 0.4）：固定前缀，永不与文章永久链接抢路径
  if (seg[0] === 'p' && seg.length === 2) {
    const pg = await db.getPost(env.DB, { slug: seg[1] });
    if (!pg || pg.type !== 'page') return html(site.render404(s), 404);
    if (pg.status !== 'published' && !user) return html(site.render404(s), 404);
    if (pg.status !== 'published') {
      pg.content_html = `<div class="empty" style="padding:14px;margin-bottom:14px">此页面为<b>草稿</b>，仅你可见 · <a href="/admin#/pages/${pg.id}">回后台编辑</a></div>` + pg.content_html;
    }
    return html(site.renderPage(s, pg));
  }

  // 文章页：按「永久链接」规则解析（放在所有固定路由之后，保证 /archive、/search 等
  // 系统路径永远优先；命中不了再兜底旧地址 /post/:slug(.html) 并 301 到当前规范地址）
  const pr = await permalinkRoute(env, s, path, user, url.origin);
  if (pr) return pr;

  // 404
  return html(site.render404(s), 404);
}

// ============ 永久链接（伪静态）解析 ============
const redirect301 = (loc) => new Response(null, {
  status: 301, headers: { location: loc, 'cache-control': 'no-store' },
});
// 路径可能是百分号编码（中文别名）；解码失败就按原样匹配，不能让异常变成 500
const safeDecode = (p) => { try { return decodeURIComponent(p); } catch (e) { return p; } };

async function permalinkRoute(env, s, path, user, origin) {
  const p0 = safeDecode(path);
  const { re, keys } = permalinkRegex(permalinkOf(s));
  const m = re.exec(p0);
  let post = null;
  if (m) {
    const kv = {};
    keys.forEach((k, i) => { kv[k] = m[i + 1]; });
    post = kv.slug
      ? await db.getPost(env.DB, { slug: kv.slug })
      : (kv.id ? await db.getPost(env.DB, { id: Number(kv.id) }) : null);
    // 页面不当文章渲染：规则恰好匹配到页面别名时（如 /{slug}），统一跳到 /p/<slug>，
    // 否则「关于我」会顶着发布时间和分类出现，看着就是一篇没归类的文章。
    if (post && post.type === 'page') return redirect301(pageUrl(post));
    // 文章改过发布时间或分类后，URL 里的日期/分类就对不上了 → 301 到当前规范地址
    if (post && !permalinkVarsMatch(kv, post)) return redirect301(postUrl(s, post));
  }
  if (!post) {
    // 旧地址 /post/xxx 与 /post/xxx.html 始终可用：改了规则后老链接不会 404
    const lm = /^\/post\/(.+?)(?:\.html)?$/.exec(p0);
    if (lm) {
      const old = await db.getPost(env.DB, { slug: lm[1] });
      if (old) return redirect301(old.type === 'page' ? pageUrl(old) : postUrl(s, old));
    }
    return null;
  }
  if (post.status !== 'published' && !user) return html(site.render404(s), 404);
  if (post.status !== 'published') {
    post.content_html = `<div class="empty" style="padding:14px;margin-bottom:14px">此文章为<b>草稿</b>，仅你可见 · <a href="/admin#/posts/${post.id}">回后台编辑</a></div>` + post.content_html;
  }
  const [siblings, comments, cfg] = await Promise.all([
    db.siblings(env.DB, post),
    db.commentsForPost(env.DB, post.id),
    Promise.resolve({
      allow: s.get('allow_comments') === '1',
      audit: s.get('comment_audit') === '1',
      captcha: s.get('captcha') !== '0',   // 未设置即默认开启
    }),
  ]);
  return html(site.renderArticle(s, post, { siblings, comments, cfg, origin }));
}

// ============ API ============
async function api(ctx, url, seg, method, envIn) {
  // 已装配好的 env 由 handle 传入（同一请求复用同一个 DocDb 与其读缓存）；
  // 单独调用时（本地测试等）兜底自己装配一次。
  const env = envIn || resolveEnv(ctx.env);
  const { request } = ctx;
  const dbx = env.DB;
  const authUser = async () => userFromRequest(env, request);

  // --- 定时备份（由 edgeone.json 的 schedules 触发，没有登录会话） ---
  // 平台定时任务无法携带自定义请求头，所以这里不强制密钥，改用两道机械约束防刷：
  //   ① 最小间隔 6 小时：上次执行时间记在 Blob 的 backups/.last-cron 里
  //   ② 备份只保留最近 20 份 → 即便被反复调用也不会无限涨
  // 如需更严的控制，配一个 CRON_KEY 环境变量，调度路径带上 ?key= 即可强制校验。
  if (seg[0] === 'cron' && seg.length === 2 && seg[1] === 'backup') {
    if (method !== 'POST' && method !== 'GET') return err('方法不允许', 405);
    const want = env.CRON_KEY;
    if (want && url.searchParams.get('key') !== want) return err('密钥不正确', 403);

    const STAMP = 'backups/.last-cron';
    const stamp = await env.BLOG.get(STAMP);
    const lastAt = stamp ? Number(await stamp.text()) || 0 : 0;
    if (lastAt && Date.now() - lastAt < 6 * 3600e3) {
      return json({ ok: true, skipped: 'too-soon', lastAt });
    }

    const data = await db.dumpAll(dbx);
    const rnd = Math.random().toString(36).slice(2, 6);
    const key = `backups/backup-${bnNow().replace(/[-: ]/g, '')}-${rnd}.json`;
    await env.BLOG.put(key, JSON.stringify(data, null, 2), {
      httpMetadata: { contentType: 'application/json' }, customMetadata: { ct: 'application/json' },
    });
    // 清理时只数 .json，别把 .last-cron 这个状态文件也算进备份队列
    const all = (await env.BLOG.list({ prefix: 'backups/' })).objects || [];
    const old = all.filter((o) => /\.json$/.test(o.key)).sort((a, b) => b.uploaded - a.uploaded).slice(20);
    for (const o of old) await env.BLOG.delete(o.key);
    await env.BLOG.put(STAMP, String(Date.now()));
    return json({ ok: true, key, at: bnNow() });
  }

  // --- 安装状态（公开） ---
  if (seg[0] === 'state' && method === 'GET' && seg.length === 1) {
    const installed = await db.isInstalled(dbx);
    const u = await authUser();
    return json({ installed, authed: !!u, username: u });
  }

  // --- 初始化向导（公开，仅未安装时） ---
  if (seg[0] === 'setup' && method === 'POST' && seg.length === 1) {
    if (await db.isInstalled(dbx)) return err('系统已初始化，如需重置请直接修改数据库', 403);
    const b = (await readJson(request)) || {};
    const username = String(b.username || '').trim();
    const password = String(b.password || '');
    if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) return err('用户名需为 3–32 位字母、数字或下划线');
    if (password.length < 6) return err('密码至少 6 位');
    // 邮箱选填：只校验格式，不验证是否真实存在。注意先校验完整串再截断，
    // 反过来（先截断）会把长地址截成一串 a 再判为非法
    const emailRaw = String(b.email || '').trim();
    if (emailRaw && !isEmail(emailRaw)) return err('邮箱格式不正确（示例：name@example.com）');
    const email = emailRaw.slice(0, 120);
    const salt = newSalt();
    const hash = await pbkdf2(password, salt);
    await db.setSetting(dbx, 'site_title', String(b.site_title || '').trim().slice(0, 60) || '我的博客');
    if (b.site_subtitle != null) await db.setSetting(dbx, 'site_subtitle', String(b.site_subtitle).slice(0, 80));
    if (b.author_name != null) await db.setSetting(dbx, 'author_name', String(b.author_name).slice(0, 30));
    if (b.accent && isHexColor(String(b.accent))) await db.setSetting(dbx, 'accent', b.accent);
    if (email) await db.setSetting(dbx, 'email', email);
    await db.setSetting(dbx, 'admin_username', username);
    await db.setSetting(dbx, 'admin_pass_salt', salt);
    await db.setSetting(dbx, 'admin_pass_hash', hash);
    await db.setSetting(dbx, 'admin_pass_iter', String(100000));
    // 补全站点默认设置（原 SQL 版在 migration 里播种）。放在显式赋值之后，
    // 只填空缺，不会盖掉表单里带过来的值。
    await db.ensureDefaultSettings(dbx);
    const value = await makeSessionValue(env, username);
    return jset({ ok: true }, setSessionCookie(value));
  }

  // --- 登录 / 登出 / 当前用户（登出公开即可） ---
  if (seg[0] === 'auth' && seg[1]) {
    if (seg[1] === 'login' && method === 'POST' && seg.length === 2) {
      const b = (await readJson(request)) || {};
      const uname = String(b.username || '').trim();
      const u2 = await db.getSetting(dbx, 'admin_username');
      if (!u2 || u2 !== uname) return err('用户名或密码错误', 401);
      const salt = await db.getSetting(dbx, 'admin_pass_salt');
      const hash = await db.getSetting(dbx, 'admin_pass_hash');
      const iter = parseInt(await db.getSetting(dbx, 'admin_pass_iter'), 10) || 100000;
      if ((await pbkdf2(String(b.password || ''), salt, iter)) !== hash) return err('用户名或密码错误', 401);
      const value = await makeSessionValue(env, uname);
      return jset({ ok: true, username: uname }, setSessionCookie(value));
    }
    if (seg[1] === 'logout' && method === 'POST') return jset({ ok: true }, clearSessionCookie());
    if (seg[1] === 'me' && method === 'GET') {
      const u = await authUser();
      if (!u) return err('未登录', 401);
      return json({ username: u });
    }
    return err('接口不存在', 404);
  }

  // --- 算术验证码图片（公开）：下发 SVG，同时把签名后的答案写入 HttpOnly Cookie ---
  if (seg[0] === 'captcha' && method === 'GET' && seg.length === 1) {
    const cap = await newCaptcha(env);
    return new Response(cap.svg, {
      status: 200,
      headers: {
        'content-type': 'image/svg+xml; charset=utf-8',
        'cache-control': 'no-store, no-cache, must-revalidate',
        'content-security-policy': "default-src 'none'",
        'set-cookie': cap.cookie,
      },
    });
  }

  // --- 文章阅读量（公开） ---
  // 只统计「单篇文章」被打开的次数，供文章页与后台列表显示。
  // ⚠️ 注意与 /api/hit 的区别：那个是整站 PV（每次访问 +1），写入频率太高，
  //    在 Blob 上没有原子自增必然丢计数 —— 已整个下线，不要再把它加回来。
  //    阅读数是文章维度的低频写，可以接受偶发少记一次。
  // 前端在文章详情页用 fetch 异步上报，不等结果，失败也不影响阅读。
  if (seg[0] === 'view' && method === 'POST' && seg.length === 1) {
    const b = (await readJson(request)) || {};
    try {
      if (b.slug) await db.incView(dbx, String(b.slug));
    } catch (e) {
      // 计数挂了不能连累读者：静默记录，照常返回成功
      console.error('view error:', e);
    }
    return json({ ok: true });
  }

  // --- 读者提交评论（公开） ---
  if (seg[0] === 'comments' && method === 'POST' && seg.length === 1) {
    const b = (await readJson(request)) || {};
    const slug = String(b.slug || '').slice(0, 120);
    const post = await db.getPost(dbx, { slug });
    if (!post || post.status !== 'published') return err('文章不存在', 404);
    if ((await db.getSetting(dbx, 'allow_comments')) !== '1') return err('评论功能已关闭', 403);
    if (b.company) return json({ ok: true, pending: false }); // 蜜罐命中：静默放行
    const author = String(b.author || '').trim().slice(0, 40);
    const email = String(b.email || '').trim().slice(0, 120);
    const website = String(b.website || '').trim().slice(0, 200);
    const content = String(b.content || '').trim();
    if (!author) return err('请填写昵称');
    if (content.length < 3 || content.length > 2000) return err('评论内容需在 3–2000 字之间');
    // 邮箱必填：用于生成 Gravatar 头像（仅存 MD5 后的头像地址，不公开邮箱原文）
    if (!email) return err('请填写邮箱（用于显示头像，不会公开）');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err('邮箱格式不正确');
    if (website && !/^https?:\/\/[^\s]+$/i.test(website)) return err('网址需以 http:// 或 https:// 开头');
    // 算术验证码：默认开启（设置项缺失即视为开启），答错/过期都拒绝
    const capOn = (await db.getSetting(dbx, 'captcha')) !== '0';
    if (capOn && !(await checkCaptcha(env, request, b.captcha))) {
      return err('验证码不正确或已过期，请点击图片换一张');
    }
    const ip = request.headers.get('CF-Connecting-IP') || '';
    if ((await db.recentCommentsByIp(dbx, ip, 60)) >= 5) return err('评论过于频繁，请稍后再试', 429);
    const audit = (await db.getSetting(dbx, 'comment_audit')) === '1';
    await db.addComment(dbx, {
      postId: post.id, author, email, website, content,
      status: audit ? 'pending' : 'approved', isAdmin: 0, ip,
    });
    // 邮件通知异步发：SMTP 握手可能要 1–3 秒，不能拖慢读者提交评论的响应
    bgTask(ctx, notifyNewComment(dbx, url.origin, post, { author, email, content, status: audit ? 'pending' : 'approved' }));
    // 验证码一次性：用掉即作废（前端随后会自动换一张新图）
    return capOn ? jset({ ok: true, pending: audit }, clearCaptchaCookie()) : json({ ok: true, pending: audit });
  }

  // --- 读者申请友链（公开） ---
  // 与评论同一套防刷：蜜罐 + 算术验证码 + 同 IP 频控；进来一律 pending，前台不展示。
  if (seg[0] === 'link-apply' && method === 'POST' && seg.length === 1) {
    const b = (await readJson(request)) || {};
    if (b.company) return json({ ok: true }); // 蜜罐命中：静默放行，不让机器人察觉
    const name = String(b.name || '').trim().slice(0, 40);
    const url = String(b.url || '').trim().slice(0, 300);
    const description = String(b.description || '').trim().slice(0, 120);
    const logo = String(b.logo || '').trim().slice(0, 300);
    const contact = String(b.contact || '').trim().slice(0, 80);
    const reason = String(b.reason || '').trim().slice(0, 300);
    if (!name) return err('请填写站点名称');
    if (!url) return err('请填写站点地址');
    // 只放行 http(s)：这些地址会原样写进 <a href>，必须挡掉 javascript: 等伪协议
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return err('网址需以 http:// 或 https:// 开头');
    if (logo && !/^https?:\/\/[^\s]+$/i.test(logo)) return err('图标地址需以 http:// 或 https:// 开头');
    const capOn = (await db.getSetting(dbx, 'captcha')) !== '0';
    if (capOn && !(await checkCaptcha(env, request, b.captcha))) {
      return err('验证码不正确或已过期，请点击图片换一张');
    }
    const ip = request.headers.get('CF-Connecting-IP') || '';
    if ((await db.recentLinkApplies(dbx, ip, 3600)) >= 3) return err('申请过于频繁，请稍后再试', 429);
    // 同网址去重（忽略末尾斜杠）：已在列表里或已提交过申请都不再收
    if (await db.findLinkByUrl(dbx, url)) return err('该站点已在友链列表或已提交过申请');
    await db.addLink(dbx, { name, url, description, logo, contact, reason, status: 'pending', source: 'apply', ip });
    return capOn ? jset({ ok: true }, clearCaptchaCookie()) : json({ ok: true });
  }

  // ================= 以下全部需登录 =================
  const user = await authUser();
  if (!user) return err('未登录或会话已过期', 401);

  // --- 媒体（R2） ---
  if (seg[0] === 'media') {
    if (method === 'POST' && seg.length === 1) {
      const ctRaw = request.headers.get('content-type') || '';
      const ct = ctRaw.split(';')[0].trim().toLowerCase();
      const allow = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/x-icon': 'ico' };
      const ext = allow[ct];
      if (!ext) return err('仅支持 PNG / JPG / GIF / WebP / AVIF / BMP 图片', 415);
      const len = parseInt(request.headers.get('content-length') || '0', 10);
      // 上限 5MB：EdgeOne 云函数的请求体硬上限是 6MB（原 Cloudflare 版是 8MB），
      // 这里留 1MB 余量，避免图片刚好卡在边界时被平台先拒、而报错信息还看不懂。
      // 实际影响很小 —— 浏览器端上传前会先转 WebP，通常只剩几百 KB。
      if (len > 5 * 1024 * 1024) return err('图片不能超过 5MB（浏览器端转 WebP 后通常只有几百 KB）', 413);
      const key = `media/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      await env.BLOG.put(key, request.body, { httpMetadata: { contentType: ct }, customMetadata: { ct } });
      return json({ ok: true, key, url: '/media/' + key });
    }
    if (method === 'GET' && seg.length === 1) {
      const list = await env.BLOG.list({ prefix: 'media/', cursor: url.searchParams.get('cursor') || undefined, limit: 200 });
      return json({
        items: (list.objects || []).map((o) => ({
          key: o.key, size: o.size, uploaded: o.uploaded,
          ct: o.customMetadata?.ct || mimeOfExt(o.key),
          url: '/media/' + o.key,
        })),
        truncated: list.truncated, cursor: list.cursor,
      });
    }
    if (method === 'DELETE') {
      const key = String(url.searchParams.get('key') || '');
      if (!key.startsWith('media/')) return err('非法文件路径', 400);
      await env.BLOG.delete(key);
      return json({ ok: true });
    }
    return err('接口不存在', 404);
  }

  // --- 备份（R2） ---
  // 说明：路由是单数 /api/backup；'backups' 作为别名保留，兼容旧版前端的复数写法
  if (seg[0] === 'backup' || seg[0] === 'backups') {
    if (method === 'POST' && seg.length === 1) {
      const data = await db.dumpAll(dbx);
      // 文件名只精确到秒：同一秒内连点两次备份会生成同名文件互相覆盖，补 4 位随机后缀避免
      const rnd = Math.random().toString(36).slice(2, 6);
      const key = `backups/backup-${bnNow().replace(/[-: ]/g, '')}-${rnd}.json`;
      await env.BLOG.put(key, JSON.stringify(data, null, 2), { httpMetadata: { contentType: 'application/json' }, customMetadata: { ct: 'application/json' } });
      const all = (await env.BLOG.list({ prefix: 'backups/' })).objects || [];
      const old = all.sort((a, b) => b.uploaded - a.uploaded).slice(20);
      for (const o of old) await env.BLOG.delete(o.key);
      return json({ ok: true, key });
    }
    if (method === 'GET' && seg.length === 1) {
      const all = (await env.BLOG.list({ prefix: 'backups/', limit: 100 })).objects || [];
      return json({ items: all.sort((a, b) => b.uploaded - a.uploaded).map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded, name: o.key.split('/').pop() })) });
    }
    if (method === 'GET' && seg.length === 2 && seg[1] !== 'restore') {
      const obj = await env.BLOG.get('backups/' + seg[1]);
      if (!obj) return err('备份不存在', 404);
      return new Response(obj.body, { headers: { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${seg[1]}"` } });
    }
    // DELETE /api/backup/:name —— 从 R2 删除指定备份
    if (method === 'DELETE' && seg.length === 2) {
      const name = String(seg[1] || '');
      // 只允许 backups/ 下的单层文件名：挡住 `../`、`a/b` 这类穿越写法，
      // 否则传 `../media/xxx` 就能删掉图片库里的文件
      if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) return err('备份文件名不合法', 400);
      const key = 'backups/' + name;
      // head 只取元信息不下载正文，备份文件可能有几 MB
      const exist = env.BLOG.head ? await env.BLOG.head(key) : await env.BLOG.get(key);
      if (!exist) return err('备份不存在或已被删除', 404);
      await env.BLOG.delete(key);
      return json({ ok: true, deleted: name });
    }
    if (seg[1] === 'restore' && method === 'POST' && seg.length === 2) {
      const b = (await readJson(request)) || {};
      let data = b.data;
      if (b.key) {
        const obj = await env.BLOG.get(String(b.key));
        if (!obj) return err('备份不存在', 404);
        data = await obj.json();
      }
      if (!data || !Array.isArray(data.posts)) return err('备份数据格式不正确');
      const n = await db.restoreAll(dbx, data);
      return json({ ok: true, restored: n });
    }
    return err('接口不存在', 404);
  }

  // --- 主题管理（R2 themes/ 前缀；default 为内置主题） ---
  if (seg[0] === 'themes') {
    // GET /api/themes —— 列出内置 + 已上传主题
    if (method === 'GET' && seg.length === 1) {
      const active = (await db.getSetting(dbx, 'active_theme')) || 'default';
      const items = [{
        id: 'default', name: '系统默认', author: '内置', version: '1.0',
        description: '页面骨架自带的默认外观（浅色），无需任何文件。', builtin: true, active: active === 'default',
      }];
      const list = await env.BLOG.list({ prefix: 'themes/', limit: 1000 });
      const ids = new Set();
      for (const o of list.objects || []) {
        const m = /^themes\/([^/]+)\//.exec(o.key);
        if (m) ids.add(m[1]);
      }
      for (const id of [...ids].sort()) {
        const meta = { id, name: id, author: '', version: '', description: '', builtin: false, active: active === id };
        try {
          const j = await env.BLOG.get('themes/' + id + '/theme.json');
          if (j) {
            const t = await j.json();
            meta.name = String(t.name || id).slice(0, 60);
            meta.author = String(t.author || '').slice(0, 60);
            meta.version = String(t.version || '').slice(0, 20);
            meta.description = String(t.description || '').slice(0, 300);
          }
        } catch (e) { /* 元信息缺失或损坏时用 id 兜底 */ }
        items.push(meta);
      }
      return json({ items, active });
    }

    // POST /api/themes/upload?dir=<id>&path=<相对路径>  body=文件原始字节
    if (method === 'POST' && seg[1] === 'upload' && seg.length === 2) {
      const dir = String(url.searchParams.get('dir') || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
      if (!dir || dir === 'default' || !/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(dir)) {
        return err('主题 ID 需为小写字母/数字/连字符（且不可用 default）', 400);
      }
      const rel = String(url.searchParams.get('path') || '').split('/').filter((x) => x && x !== '.' && x !== '..' && !x.includes('\\'));
      if (!rel.length || rel.join('/').length > 160) return err('非法文件路径', 400);
      const len = parseInt(request.headers.get('content-length') || '0', 10);
      if (len > 5 * 1024 * 1024) return err('主题单文件不能超过 5MB', 413);
      const key = `themes/${dir}/${rel.join('/')}`;
      const ct = mimeOfExt(key);
      await env.BLOG.put(key, request.body, { httpMetadata: { contentType: ct }, customMetadata: { ct } });
      return json({ ok: true, key });
    }

    // POST /api/themes/activate  body:{id}
    if (method === 'POST' && seg[1] === 'activate' && seg.length === 2) {
      const b = (await readJson(request)) || {};
      const id = String(b.id || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
      if (!id || id === 'default') {
        await db.setSetting(dbx, 'active_theme', 'default');
        return json({ ok: true, active: 'default' });
      }
      if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(id)) return err('主题 ID 不合法', 400);
      const css = await env.BLOG.get('themes/' + id + '/style.css');
      if (!css) return err('主题不存在或缺少 style.css', 404);
      await db.setSetting(dbx, 'active_theme', id);
      return json({ ok: true, active: id });
    }

    // DELETE /api/themes/:id —— 删除主题文件；若正被启用则自动回退内置默认
    if (method === 'DELETE' && seg.length === 2) {
      const id = String(seg[1]).toLowerCase().replace(/[^a-z0-9-]+/g, '').slice(0, 40);
      if (!id || id === 'default') return err('内置主题不可删除', 400);
      let cursor;
      let deleted = 0;
      do {
        const r = await env.BLOG.list({ prefix: 'themes/' + id + '/', limit: 1000, cursor });
        for (const o of r.objects || []) { await env.BLOG.delete(o.key); deleted++; }
        cursor = r.truncated ? r.cursor : undefined;
      } while (cursor);
      const active = (await db.getSetting(dbx, 'active_theme')) || 'default';
      if (active === id) {
        await db.setSetting(dbx, 'active_theme', 'default');
        return json({ ok: true, deleted, activeFallback: 'default' });
      }
      return json({ ok: true, deleted });
    }
    return err('接口不存在', 404);
  }

  // --- 统计 ---
  if (seg[0] === 'stats' && method === 'GET' && seg.length === 1) return json(await db.stats(dbx));

  // --- 仪表盘（后台首页）---
  // 一次拿齐：总览数字 + 待审评论 + 最近文章 / 最近评论 / 友链申请。
  // 所有查询并行发起，避免串行往返把延迟叠加起来。
  if (seg[0] === 'dashboard' && method === 'GET' && seg.length === 1) {
    const monthStart = bnNow().slice(0, 8) + '01'; // 本月 1 号 00:00（北京时间字符串可直接比大小）
    const [st, pending, recent, cmts, agg, top, linkCnt, linkPending, sm] = await Promise.all([
      db.stats(dbx),
      db.listComments(dbx, { status: 'pending', limit: 5 }),
      db.listPosts(dbx, { status: 'all', page: 1, per: 6 }),
      db.listComments(dbx, { status: 'all', limit: 6 }),
      // 字数用文章元数据里的 word_count 求和（保存时算好），不必把全站正文读一遍
      db.dashboardAggregates(dbx, monthStart),
      // 热门文章 TOP 5（按累计阅读数；只排元数据，不读正文）
      db.topPosts(dbx, 5),
      db.countLinksByStatus(dbx).catch(() => ({ pending: 0, approved: 0, rejected: 0 })),
      db.listLinks(dbx, { status: 'pending' }).then((l) => l.slice(0, 5)).catch(() => []),
      db.settingsMap(dbx),   // 取永久链接规则，给下面两条列表补上文章地址
    ]);
    // 裁剪字段：正文等大字段不下发，省流量也省前端解析
    const tc = (c) => ({
      id: c.id, author: c.author, content: c.content, status: c.status,
      is_admin: c.is_admin, created_at: c.created_at,
      post_title: c.post_title, post_slug: c.post_slug,
    });
    return json({
      counts: { ...st, words: agg.words, month_posts: agg.month_posts, month_comments: agg.month_comments },
      pending: pending.map(tc),
      recent_posts: recent.items.map((p) => ({
        id: p.id, title: p.title, slug: p.slug, status: p.status,
        published_at: p.published_at, updated_at: p.updated_at,
        comments: p.comment_count || 0, url: postUrl(sm, p),
      })),
      // 热门文章 TOP 5：与「最近文章」同源（都已发布文章），只是排序口径不同
      top_posts: top.map((p) => ({
        id: p.id, title: p.title, slug: p.slug,
        views: p.view_count || 0, url: postUrl(sm, p),
      })),
      recent_comments: cmts.map(tc),
      // 友链：待审数量 + 最近几条待审申请（仪表盘直接给出提醒与处理入口）
      links: { pending: (linkCnt && linkCnt.pending) || 0, approved: (linkCnt && linkCnt.approved) || 0,
        pending_list: (linkPending || []).map((l) => ({
          id: l.id, name: l.name, url: l.url, description: l.description,
          contact: l.contact, reason: l.reason, created_at: l.created_at,
        })) },
      generated_at: bnNow(),
    });
  }

  // --- 预览（返回完整 HTML 供编辑器 iframe 展示） ---
  if (seg[0] === 'preview' && method === 'POST' && seg.length === 1) {
    const b = (await readJson(request)) || {};
    const s = await db.settingsMap(dbx);
    const post = { title: String(b.title || '').trim().slice(0, 200), content_html: render(String(b.content_md || '')) };
    return json({ html: site.previewDoc(s, post, url.origin) });
  }

  // --- 设置 ---
  // /api/settings/read 是后台读取设置的地址（与写入用的 /api/settings 同一份数据）；
  // 之前只认 seg.length===1，读设置会落到 404，设置页所有输入框都是空的。
  if (seg[0] === 'settings' && (seg.length === 1 || (seg[1] === 'read' && seg.length === 2))) {
    if (method === 'GET') {
      const all = await db.allSettings(dbx);
      // 发信授权码任何情况下都不回传（回显只会增加泄露面）
      // 本接口位于登录守卫之后，属私有接口；这里再兜一层，防止日后被挪到公开区
      const hasPass = !!all.mail_pass;
      delete all.admin_pass_hash;
      delete all.admin_pass_salt;
      delete all.admin_pass_iter;
      delete all.mail_pass;
      all.mail_pass_set = hasPass ? '1' : '0';
      if (!(await authUser())) delete all.email;
      return json(all);
    }
    if (method === 'PATCH' && seg.length === 1) {
    const b = (await readJson(request)) || {};
    // 永久链接先校验再写：不合法直接拒，避免落一半字段；空串表示恢复默认
    if (b.permalink != null) {
      const pm = normalizePermalink(b.permalink);
      if (!pm) return err('永久链接格式不合法：需以 / 开头且包含 {slug} 或 {id}，可用变量 {year} {month} {day} {category}');
      await db.setSetting(dbx, 'permalink', pm);
    }
    // 博主邮箱同先校验后写：留空表示清除，填了必须是合法格式（不验证是否真实存在）
    if (b.email != null) {
      const em = String(b.email).trim();
      if (em && !isEmail(em)) return err('邮箱格式不正确（示例：name@example.com）');
      await db.setSetting(dbx, 'email', em.slice(0, 120));
    }
    const allowed = { site_title: 60, site_subtitle: 80, author_name: 30, footer_text: 500, seo_desc: 200, beian: 100, copyright: 600 };
    // 代码高亮主题与头像源：取值受限，避免写入任意值
    if (b.code_theme != null) {
      const t = String(b.code_theme).slice(0, 30);
      if (CODE_THEMES.some((x) => x.id === t)) await db.setSetting(dbx, 'code_theme', t);
    }
    if (b.gravatar_source != null) {
      const g = String(b.gravatar_source).slice(0, 20);
      if (['weavatar', 'cravatar', 'sepcc', 'gravatar', 'secure'].includes(g)) await db.setSetting(dbx, 'gravatar_source', g);
    }
    for (const k of Object.keys(allowed)) {
      if (b[k] != null) await db.setSetting(dbx, k, String(b[k]).slice(0, allowed[k]));
    }
    // 图标地址：只接受站内相对路径或 http(s)，挡掉 javascript: 等伪协议；传空串表示清除
    const safeUrl = (v) => (/^(https?:\/\/|\/)/i.test(String(v || '').trim()) ? String(v).trim().slice(0, 300) : '');
    if (b.logo_image != null) await db.setSetting(dbx, 'logo_image', safeUrl(b.logo_image));
    if (b.favicon_image != null) await db.setSetting(dbx, 'favicon_image', safeUrl(b.favicon_image));
    if (b.per_page != null) await db.setSetting(dbx, 'per_page', String(Math.min(20, Math.max(1, parseInt(b.per_page, 10) || 8))));
    if (b.allow_comments != null) await db.setSetting(dbx, 'allow_comments', b.allow_comments ? '1' : '0');
    if (b.comment_audit != null) await db.setSetting(dbx, 'comment_audit', b.comment_audit ? '1' : '0');
    if (b.captcha != null) await db.setSetting(dbx, 'captcha', b.captcha ? '1' : '0');
    // ---- 导航栏显示开关：关掉只是不出现在页头导航，页面地址照常可访问 ----
    for (const k of ['categories', 'tags', 'archive', 'links', 'rss']) {
      if (b['nav_show_' + k] != null) await db.setSetting(dbx, 'nav_show_' + k, b['nav_show_' + k] ? '1' : '0');
    }
    // ---- 邮件通知 ----
    // 端口必须是该服务商真开了的（163 没有 587、Office365 没有 465）。
    // 存了不支持的组合，现象是「连上就断」或「干等到超时」，与账号密码无关、极难排查，所以入库前拦住。
    if (b.mail_provider != null || b.mail_port != null || b.mail_secure != null) {
      const cur = await db.settingsMap(dbx);
      const tryCfg = {
        provider: b.mail_provider != null ? String(b.mail_provider).trim() : (cur.get('mail_provider') || '163'),
        port: b.mail_port != null ? parseInt(b.mail_port, 10) : (parseInt(cur.get('mail_port'), 10) || 465),
        secure: b.mail_secure != null
          ? (String(b.mail_secure) === 'starttls' ? 'starttls' : 'ssl')
          : (cur.get('mail_secure') === 'starttls' ? 'starttls' : 'ssl'),
      };
      const pi = mailPortIssue(tryCfg);
      if (pi) return err(pi, 400);
    }
    const MAIL_STR = { mail_provider: 20, mail_host: 120, mail_secure: 10, mail_user: 120, mail_from_name: 60, mail_template: 20 };
    for (const k of Object.keys(MAIL_STR)) {
      if (b[k] != null) await db.setSetting(dbx, k, String(b[k]).trim().slice(0, MAIL_STR[k]));
    }
    for (const k of ['mail_enabled', 'mail_on_comment', 'mail_on_reply']) {
      if (b[k] != null) await db.setSetting(dbx, k, b[k] ? '1' : '0');
    }
    // 授权码只写不读：留空表示保持原值，要清除需显式传 mail_clear_pass
    if (b.mail_pass != null && String(b.mail_pass) !== '') {
      await db.setSetting(dbx, 'mail_pass', String(b.mail_pass).slice(0, 200));
    } else if (b.mail_clear_pass === true) {
      await db.setSetting(dbx, 'mail_pass', '');
    }
    if (b.mail_port != null) {
      const p = parseInt(b.mail_port, 10);
      // 云平台普遍封禁 25 端口，直接拒，免得配完发不出去还查不出原因
      if (p === 25) return err('云平台普遍封禁 25 端口，请使用 465（SSL）或 587（STARTTLS）');
      await db.setSetting(dbx, 'mail_port', String(Math.min(65535, Math.max(1, p || 465))));
    }
    if (b.accent && isHexColor(String(b.accent))) await db.setSetting(dbx, 'accent', b.accent);
    if (b.new_password && String(b.new_password).length >= 6) {
      const salt = newSalt();
      await db.setSetting(dbx, 'admin_pass_salt', salt);
      await db.setSetting(dbx, 'admin_pass_hash', await pbkdf2(String(b.new_password), salt));
      await db.setSetting(dbx, 'admin_pass_iter', String(100000));
    }
    return json({ ok: true });
  }
  }

  // --- 友链管理 ---
  if (seg[0] === 'links') {
    if (method === 'GET' && seg.length === 1) {
      const status = url.searchParams.get('status') || 'all';
      const [items, counts] = await Promise.all([
        db.listLinks(dbx, { status }),
        db.countLinksByStatus(dbx),
      ]);
      return json({ items, counts });
    }
    if (method === 'POST' && seg.length === 1) {
      const b = (await readJson(request)) || {};
      const name = String(b.name || '').trim().slice(0, 40);
      const url = String(b.url || '').trim().slice(0, 300);
      if (!name) return err('请填写站点名称');
      if (!url) return err('请填写站点地址');
      if (!/^https?:\/\/[^\s]+$/i.test(url)) return err('网址需以 http:// 或 https:// 开头');
      const logo = String(b.logo || '').trim().slice(0, 300);
      if (logo && !/^https?:\/\/[^\s]+$/i.test(logo)) return err('图标地址需以 http:// 或 https:// 开头');
      const id = await db.addLink(dbx, {
        name, url, logo,
        description: String(b.description || '').trim().slice(0, 120),
        contact: String(b.contact || '').trim().slice(0, 80),
        reason: String(b.reason || '').trim().slice(0, 300),
        sort: Math.max(0, Math.min(9999, parseInt(b.sort, 10) || 0)),
        status: db.LINK_STATUS.includes(b.status) ? b.status : 'approved', // 博主自己加的，默认直接展示
        source: 'admin',
      });
      return json({ ok: true, id });
    }
    if (seg.length === 2 && /^\d+$/.test(seg[1])) {
      const id = parseInt(seg[1], 10);
      if (method === 'PATCH') {
        const b = (await readJson(request)) || {};
        const patch = {};
        if (b.status != null) {
          if (!db.LINK_STATUS.includes(b.status)) return err('状态值不合法');
          patch.status = b.status;
        }
        ['name', 'url', 'description', 'logo', 'contact', 'reason'].forEach((k) => {
          if (b[k] != null) patch[k] = String(b[k]).trim().slice(0, k === 'url' || k === 'logo' ? 300 : 120);
        });
        if (patch.url && !/^https?:\/\/[^\s]+$/i.test(patch.url)) return err('网址需以 http:// 或 https:// 开头');
        if (patch.logo && !/^https?:\/\/[^\s]+$/i.test(patch.logo)) return err('图标地址需以 http:// 或 https:// 开头');
        if (b.sort != null) patch.sort = Math.max(0, Math.min(9999, parseInt(b.sort, 10) || 0));
        if (!Object.keys(patch).length) return err('没有要修改的字段');
        await db.updateLink(dbx, id, patch);
        return json({ ok: true });
      }
      if (method === 'DELETE') {
        await db.deleteLink(dbx, id);
        return json({ ok: true });
      }
    }
    return err('接口不存在', 404);
  }

  // --- 分类管理 ---
  if (seg[0] === 'categories') {
    if (method === 'GET' && seg.length === 1) return json(await db.listCategories(dbx));
    if (method === 'POST' && seg.length === 1) {
      const b = (await readJson(request)) || {};
      const name = String(b.name || '').trim().slice(0, 30);
      if (!name) return err('请输入分类名称');
      // 别名只放行英文/数字/-：中文名会被 slugify 洗成空串，过去会悄悄变成 cat-123456 这种随机串，
      // 现在明确拒绝，让用户在后台自己填一个可读的别名
      const slugRaw = b.slug == null ? '' : String(b.slug).trim().slice(0, 60);
      if (slugRaw && !/^[a-zA-Z0-9-]+$/.test(slugRaw)) return err('别名只能用英文字母、数字和连字符 -');
      // 上级分类：只能挂在「顶级分类」下，只支持两级
      const pid = parseInt(b.parent_id, 10) || 0;
      if (pid) {
        const p = await db.getCategory(dbx, pid);
        if (!p) return err('上级分类不存在');
        if (p.parent_id) return err('只支持两级分类：不能把分类挂在二级分类下面');
      }
      const r = await db.createCategory(dbx, {
        name, slug: slugRaw, description: String(b.description || '').slice(0, 200),
        parent_id: pid, in_nav: b.in_nav,
      });
      return json({ ok: true, id: r.id, slug: r.slug, parent_id: r.parent_id, in_nav: r.in_nav });
    }
    if (seg.length === 2 && /^\d+$/.test(seg[1])) {
      const id = parseInt(seg[1], 10);
      if (method === 'PUT') {
        const b = (await readJson(request)) || {};
        const name = String(b.name || '').trim().slice(0, 30);
        if (!name) return err('请输入分类名称');
        const slugRaw = b.slug == null ? '' : String(b.slug).trim().slice(0, 60);
        if (slugRaw && !/^[a-zA-Z0-9-]+$/.test(slugRaw)) return err('别名只能用英文字母、数字和连字符 -');
        // parent_id 传 0 表示改回顶级；不传则保持原上级不变
        const pidRaw = b.parent_id;
        let pid;
        if (pidRaw === 0 || pidRaw === '0') pid = 0;
        else if (pidRaw == null || pidRaw === '') pid = null;   // null = 不动
        else pid = parseInt(pidRaw, 10) || 0;
        if (pid) {
          const p = await db.getCategory(dbx, pid);
          if (!p) return err('上级分类不存在');
          if (p.parent_id) return err('只支持两级分类：不能把分类挂在二级分类下面');
          if (Number(p.id) === Number(id)) return err('上级不能是它自己');
        }
        const slug = await db.updateCategory(dbx, id, {
          name, slug: slugRaw, description: String(b.description || '').slice(0, 200),
          parent_id: pid, in_nav: b.in_nav,
        });
        return json({ ok: true, slug });
      }
      if (method === 'DELETE') {
        await db.deleteCategory(dbx, id);
        return json({ ok: true });
      }
    }
    return err('接口不存在', 404);
  }

  // --- 标签管理（改名请直接在文章编辑页调整） ---
  if (seg[0] === 'tags') {
    if (method === 'GET' && seg.length === 1) return json(await db.listTags(dbx));
    if (seg.length === 2 && /^\d+$/.test(seg[1])) {
      const id = parseInt(seg[1], 10);
      if (method === 'PUT') return err('标签改名请在文章编辑页中调整', 400);
      if (method === 'DELETE') {
        await db.deleteTag(dbx, id);
        return json({ ok: true });
      }
    }
    return err('接口不存在', 404);
  }

  // --- 文章管理 ---
  if (seg[0] === 'posts') {
    // 列表 GET /api/posts
    if (method === 'GET' && seg.length === 1) {
      const status = String(url.searchParams.get('status') || 'published');
      if (status !== 'published' && !user) return err('未登录', 401);
      const data = await db.listPosts(dbx, {
        status,
        // 默认只给文章；后台「页面」菜单传 type=page，互不干扰
        type: String(url.searchParams.get('type') || 'post'),
        q: url.searchParams.get('q') || '',
        cat: url.searchParams.get('cat') || undefined,
        tag: url.searchParams.get('tag') || undefined,
        page: parseInt(url.searchParams.get('page'), 10) || 1,
        per: Math.min(100, parseInt(url.searchParams.get('per'), 10) || 20),
      });
      // 带上按当前永久链接规则算出的地址，后台列表直接展示，不必再拼 /post/:slug
      const sm = await db.settingsMap(dbx);
      data.items = data.items.map((p) => ({ ...p, url: p.type === 'page' ? pageUrl(p) : postUrl(sm, p) }));
      return json(data);
    }
    // 新建 POST /api/posts
    if (method === 'POST' && seg.length === 1) {
      const body = (await readJson(request)) || {};
      const title = String(body.title || '').trim();
      const contentMd = String(body.content_md || '');
      if (!title) return err('请填写文章标题');
      if (!contentMd.trim()) return err('请填写文章内容');
      const status = body.status === 'published' ? 'published' : 'draft';
      const contentHtml = render(contentMd);
      let excerpt = String(body.excerpt || '').trim().slice(0, 300);
      if (!excerpt) excerpt = stripHtml(contentHtml).slice(0, 180);
      const id = await db.createPost(dbx, {
        title, slug: body.slug, status,
        type: body.type === 'page' ? 'page' : 'post',
        in_nav: body.in_nav,   // 未传时 db 层默认 1（导航显示）
        category_id: body.category_id ? parseInt(body.category_id, 10) : null,
        content_md: contentMd, content_html: contentHtml, excerpt,
        cover_key: body.cover_key || null, tags: Array.isArray(body.tags) ? body.tags : [],
      });
      const post = await db.getPost(dbx, { id });
      return json({ ok: true, id, slug: post.slug });
    }
    // 单篇操作 GET/PUT/DELETE /api/posts/:id
    if (seg.length === 2 && /^\d+$/.test(seg[1])) {
      const id = parseInt(seg[1], 10);
      const post = await db.getPost(dbx, { id });
      if (!post) return err('文章不存在', 404);
      if (method === 'GET') return json({ ...post, url: post.type === 'page' ? pageUrl(post) : postUrl(await db.settingsMap(dbx), post) });
      if (method === 'DELETE') {
        await db.deletePost(dbx, id);
        return json({ ok: true });
      }
      if (method === 'PUT') {
        const body = (await readJson(request)) || {};
        const title = String(body.title || '').trim();
        const contentMd = String(body.content_md || '');
        if (!title) return err('请填写文章标题');
        if (!contentMd.trim()) return err('请填写文章内容');
        const status = body.status === 'published' ? 'published' : 'draft';
        const contentHtml = render(contentMd);
        let excerpt = String(body.excerpt || '').trim().slice(0, 300);
        if (!excerpt) excerpt = stripHtml(contentHtml).slice(0, 180);
        await db.updatePost(dbx, id, {
          title, slug: body.slug, status,
          // type / in_nav 只在显式传了才改：文章编辑不传，就不会被误改成页面
          ...(body.type ? { type: body.type === 'page' ? 'page' : 'post' } : {}),
          ...(body.in_nav != null ? { in_nav: body.in_nav ? 1 : 0 } : {}),
          category_id: body.category_id ? parseInt(body.category_id, 10) : null,
          content_md: contentMd, content_html: contentHtml, excerpt,
          cover_key: body.cover_key || null,
          tags: Array.isArray(body.tags) ? body.tags : [],
        });
        const np = await db.getPost(dbx, { id });
        return json({ ok: true, slug: np.slug });
      }
    }
    // 发布 / 下线
    if (seg.length === 3 && seg[2] === 'publish' && method === 'POST') {
      const id = parseInt(seg[1], 10);
      const b = (await readJson(request)) || {};
      if (!['published', 'draft'].includes(b.status)) return err('非法状态');
      const ok = await db.setPostStatus(dbx, id, b.status);
      if (!ok) return err('文章不存在', 404);
      return json({ ok: true, status: b.status });
    }
    return err('接口不存在', 404);
  }
  if (seg[0] === 'admin' && seg[1] === 'comments' && seg.length === 2 && method === 'GET') {
    const status = String(url.searchParams.get('status') || 'pending');
    return json({ items: await db.listComments(dbx, { status, limit: 300 }), status });
  }
  if (seg[0] === 'comments' && seg.length === 2 && /^\d+$/.test(seg[1])) {
    const id = parseInt(seg[1], 10);
    if (method === 'PATCH') {
      const b = (await readJson(request)) || {};
      if (!['pending', 'approved', 'trash'].includes(b.status)) return err('非法状态');
      await db.setCommentStatus(dbx, id, b.status);
      return json({ ok: true });
    }
    if (method === 'DELETE') {
      await db.deleteComment(dbx, id);
      return json({ ok: true });
    }
  }
  // 博主回复 POST /api/comments/:id/reply
  if (seg[0] === 'comments' && seg.length === 3 && seg[2] === 'reply' && method === 'POST') {
    const id = parseInt(seg[1], 10);
    const b = (await readJson(request)) || {};
    const content = String(b.content || '').trim();
    if (content.length < 2 || content.length > 2000) return err('回复内容需在 2–2000 字之间');
    const parent = await db.getComment(dbx, id);
    if (!parent) return err('评论不存在', 404);
    await db.addComment(dbx, {
      postId: parent.post_id, parentId: parent.id,
      author: (await db.getSetting(dbx, 'author_name')) || '博主',
      email: '', content, status: 'approved', isAdmin: 1, ip: '',
    });
    bgTask(ctx, notifyReply(dbx, url.origin, parent, content));
    return json({ ok: true });
  }

  // --- 邮件通知：发一封测试邮件验证配置（登录） ---
  if (seg[0] === 'mail' && seg[1] === 'test' && method === 'POST' && seg.length === 2) {
    if (!(await authUser())) return err('未登录', 401);
    const s = await db.settingsMap(dbx);
    // 页面上的参数可能还没保存：允许前端把当前表单值带过来，测的就是眼睛看到的那一套。
    // 否则会出现「页面显示 465、实际测的是库里的 587」—— 报错信息跟页面对不上，无从排查
    // （Wei 就踩过：库里存了 163 不支持的 587，页面已自动改成 465，测试却仍打 587 然后报 220 被断）。
    const b = (await readJson(request)) || {};
    const cfg = mailConfigFrom(s);
    if (b.mail_host != null) cfg.host = String(b.mail_host).trim();
    if (b.mail_port != null) cfg.port = parseInt(b.mail_port, 10) || cfg.port;
    if (b.mail_secure != null) cfg.secure = String(b.mail_secure) === 'starttls' ? 'starttls' : 'ssl';
    if (b.mail_user != null) cfg.user = String(b.mail_user).trim();
    if (b.mail_pass != null && String(b.mail_pass) !== '') cfg.pass = String(b.mail_pass);
    // 服务商没开这个端口就直接说清楚，别去连一次再拿「被提前关闭」这种无法行动的错误
    const pi = mailPortIssue(cfg);
    if (pi) return err(pi, 400);
    const ce = mailConfigError(cfg);
    if (ce) return err('配置不完整：' + ce, 400);
    const to = (s.get('email') || '').trim();
    if (!to) return err('请先在「设置 → 安全设置」填写博主邮箱：测试邮件会发到这个地址', 400);
    // 用 400 而不是 502：5xx 的响应体可能被边缘平台换成自己的错误页，
    // 前端就只能看到「请求失败 (502)」而拿不到 SMTP 的真实原因。
    try {
      const m = renderMail(cfg.template, {
        kind: 'comment', site: s.get('site_title') || '博客', siteUrl: url.origin,
        postTitle: '邮件通知测试', postUrl: url.origin, adminUrl: url.origin + '/admin#/settings/comment',
        author: '系统', content: '这是一封测试邮件。收到它说明 SMTP 配置正确，评论通知可以正常工作。', pending: false,
      });
      const r = await sendMailWithTimeout(cfg, { to, subject: m.subject, text: m.text, html: m.html }, connect);
      // 把实际连接参数一并回传：页面显示的值与库里的值可能不一致（改了没保存等），
      // 报错时带上它能立刻判断到底是「配错了」还是「服务器拒绝了」。
      const used = describeCfg(cfg);
      return r.ok ? json({ ok: true, to, used }) : err(`发送失败：${r.error}｜实际连接 ${used}`, 400);
    } catch (e) {
      return err('发送出错：' + ((e && e.message) || e), 400);
    }
  }

  return err('接口不存在', 404);
}

// ============================================================
// 邮件通知：任何失败都只记日志，绝不影响评论 / 回复本身的结果
// （SMTP 可能不通、博主邮箱可能没填，这些都不该让读者提交失败）
// ============================================================
async function notifyNewComment(dbx, origin, post, c) {
  try {
    const s = await db.settingsMap(dbx);
    const cfg = mailConfigFrom(s);
    if (!cfg.enabled || !cfg.onComment) return;
    const to = (s.get('email') || '').trim();
    if (!to) return;
    const ce = mailConfigError(cfg);
    if (ce) { console.error('mail skip:', ce); return; }
    const m = renderMail(cfg.template, {
      kind: 'comment',
      site: s.get('site_title') || '博客',
      siteUrl: origin,
      postTitle: post.title || '',
      postUrl: origin + postUrl(s, post),
      adminUrl: origin + '/admin#/comments',
      author: c.author, email: c.email, content: c.content,
      pending: c.status === 'pending',
    });
    const r = await sendMailWithTimeout(cfg, { to, subject: m.subject, text: m.text, html: m.html }, connect);
    if (!r.ok) console.error('mail fail:', r.error);
  } catch (e) { console.error('mail error:', (e && e.message) || e); }
}

async function notifyReply(dbx, origin, parent, content) {
  try {
    const s = await db.settingsMap(dbx);
    const cfg = mailConfigFrom(s);
    if (!cfg.enabled || !cfg.onReply) return;
    const to = (parent.email || '').trim();
    // 回复博主自己的评论时没有收件人，直接跳过
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return;
    const ce = mailConfigError(cfg);
    if (ce) { console.error('mail skip:', ce); return; }
    const post = await db.getPost(dbx, { id: parent.post_id });
    const m = renderMail(cfg.template, {
      kind: 'reply',
      site: s.get('site_title') || '博客',
      siteUrl: origin,
      postTitle: (post && post.title) || '',
      postUrl: post ? origin + postUrl(s, post) : origin,
      adminUrl: origin + '/admin#/comments',
      author: s.get('author_name') || '博主',
      content,
      pending: false,
    });
    const r = await sendMailWithTimeout(cfg, { to, subject: m.subject, text: m.text, html: m.html }, connect);
    if (!r.ok) console.error('mail fail:', r.error);
  } catch (e) { console.error('mail error:', (e && e.message) || e); }
}
