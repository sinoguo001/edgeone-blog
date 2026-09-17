// ============ 数据访问层 ============
// 底层是「Blob 文档库」（_lib/store/docdb.js）：一张表 = 一份 JSON 文档。
// 对外导出的函数签名与语义与 Cloudflare D1 版完全一致，所以路由层不用改一行。
//
// ── 与 SQL 版的三个结构性差异，改动时最容易踩 ──
// ① 文章「正文」与「元数据」分开存：列表页只读 db/posts.json，不再把全站正文
//    一起拖下来。因此元数据里冗余了两个派生字段（保存时算好）：
//      excerpt     摘要。缺省时由正文纯文本前 260 字自动生成
//      word_count  正文 Markdown 字符数，仪表盘「总字数」直接求和，不必读正文
// ② 评论数也冗余进元数据（posts.comment_count）：列表页显示「N 评论」不该
//    为此读取全站评论。评论增删/改状态时同步维护。
// ③ Blob 没有 AUTOINCREMENT，自增 id 统一走 docdb 的 nextId()（存在 db/seq.json）。
//    ★ 恢复备份后必须把 seq 抬到已有 id 的最大值，否则新建内容会跟旧数据撞号。
// ④ 列默认值也没有地方挂（没有 DDL）：`type='post'`、`in_nav=1`（文章）、
//    `categories.parent_id=0`、`categories.in_nav=0` 这些 SQL 默认值，
//    只能靠读取时就地兜底 + 恢复备份时补写。漏掉的症状极安静 ——
//    页面会被当成文章混进首页、分类层级整个消失，且不报任何错。
//
// ── 已移除 ──
//   PV / UV 全站统计（recordHit / pvSummary / pv_daily / pv_visitor）
//   文章阅读数（incView / posts.view_count）
//   两者都是「每次访问 +1」的高频写：Blob 没有原子自增，读改写会丢计数，
//   与其显示一个不准的数字，不如干脆不做。
import { bnNow, paginate, slugify, stripHtml } from './util.js';

// 把数字或数字字符串统一成数字，避免 Blob 里存取一轮后 id 变字符串导致比较失败
const num = (v) => (v == null || v === '' ? NaN : Number(v));
const eqId = (a, b) => num(a) === num(b);
const maxId = (rows) => (rows || []).reduce((m, x) => Math.max(m, Number(x.id) || 0), 0);
// 父分类指针：缺省/空值/非数字一律当 0（顶级分类）。
// 老备份里没有 parent_id 字段，不能靠真值判断 —— Number(undefined) 是 NaN，
// 而 '0' 又是真值，两种都会把「顶级分类」误判成二级。
const pidOf = (c) => (num(c && c.parent_id) || 0);
// 二级分类的完整路径别名：顶级是自己，二级是「父/子」。
// catById 传了就用查表（文章元数据里只存了 category_id），否则用行自带的 parent_slug。
const catFullSlug = (c, catById) => {
  if (!c) return '';
  const p = catById && pidOf(c) ? catById.get(pidOf(c)) : null;
  const parentSlug = (p && p.slug) || c.parent_slug || '';
  return (parentSlug ? parentSlug + '/' : '') + String(c.slug || '');
};

// ---------- settings ----------
// 存储形态为 { key: value }，比数组好改；dumpAll 时再转回 [{key,value}] 保持备份格式
export async function getSetting(db, k, d = '') {
  const s = await db.read('settings', 'map');
  return s[k] != null ? s[k] : d;
}
export async function allSettings(db) {
  return db.read('settings', 'map');
}
// 渲染层用 Map 形态（支持 s.get('key')）
export const settingsMap = async (db) => new Map(Object.entries(await allSettings(db)));
export async function setSetting(db, k, v) {
  await db.mutate('settings', {}, (s) => {
    s[k] = String(v ?? '');
    return s;
  });
}
export const isInstalled = async (db) => !!((await getSetting(db, 'admin_username')));

// 站点默认设置。原 SQL 版挂在 migration 0001 的 `INSERT OR IGNORE INTO settings` 上，
// 数据层换成文档库后没有「建表语句」可承载，必须由代码显式播种 ——
// 漏了不会报错，只会安静地表现成「新装站点评论是关的、副标题是空的」。
// 只补空缺（== null），不覆盖用户已改过的值，所以可以放心重复调用。
export const DEFAULT_SETTINGS = {
  site_title: '我的博客',
  site_subtitle: '记录 · 思考 · 分享',
  author_name: '博主',
  per_page: '8',
  footer_text: '',
  allow_comments: '1',
  comment_audit: '1',
  accent: '#2563eb',
  seo_desc: '',
};
export async function ensureDefaultSettings(db) {
  await db.mutate('settings', {}, (s) => {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (s[k] == null) s[k] = v;
    return s;
  });
}

// ---------- 唯一别名 ----------
async function uniqueSlug(db, table, base, excludeId) {
  // excludeId：更新时排除自己，否则编辑已发布文章会把 slug 追加成 post-2-2、post-2-2-2…
  const rows = await db.read(table);
  const taken = (s) => rows.some((r) => r.slug === s && (excludeId == null || !eqId(r.id, excludeId)));
  const slug = base || '';
  if (!taken(slug)) return slug;
  for (let i = 2; i < 1000; i++) {
    const s = `${base}-${i}`;
    if (!taken(s)) return s;
  }
  return `${base}-${Date.now()}`;
}

// ---------- posts ----------
// 元数据行 → 对外结构。catById / tags / pt 由调用方一次读齐后传入，
// 避免每篇文章都去查一遍分类与标签。
function rowOf(p, catById, tags, pt) {
  const c = p.category_id != null ? catById.get(num(p.category_id)) : null;
  const parent = c && pidOf(c) ? catById.get(pidOf(c)) : null;
  const mine = [];
  for (const link of pt) {
    if (!eqId(link.post_id, p.id)) continue;
    const t = tags.find((x) => eqId(x.id, link.tag_id));
    if (t) mine.push({ id: t.id, name: t.name, slug: t.slug });
  }
  return {
    id: p.id,
    title: p.title,
    slug: p.slug,
    excerpt: p.excerpt || '',
    cover_key: p.cover_key || null,
    status: p.status,
    // 内容类型与导航开关：老数据没有这两个字段，按「文章 + 进导航」兜底
    type: p.type === 'page' ? 'page' : 'post',
    in_nav: Number(p.in_nav == null ? 1 : p.in_nav) ? 1 : 0,
    category_id: p.category_id != null ? p.category_id : null,
    created_at: p.created_at,
    updated_at: p.updated_at,
    published_at: p.published_at || null,
    comment_count: Number(p.comment_count) || 0,
    word_count: Number(p.word_count) || 0,
    category: c ? {
      id: c.id, name: c.name, slug: c.slug,
      full_slug: catFullSlug(c, catById),
      parent_name: (parent && parent.name) || '',
      parent_slug: (parent && parent.slug) || '',
    } : null,
    tags: mine,
  };
}

// 一次读齐列表页需要的四份文档（并行，省往返）
async function loadTaxonomy(db) {
  const [posts, cats, tags, pt] = await Promise.all([
    db.read('posts'), db.read('categories'), db.read('tags'), db.read('post_tags'),
  ]);
  return { posts, cats, tags, pt, catById: new Map(cats.map((c) => [num(c.id), c])) };
}

// type：'post' 文章（默认）| 'page' 独立页面 | 'all' 两者都要
// 默认只取文章：首页 / 分类 / 标签 / 归档 / 搜索 / RSS 都不该出现「关于我」这类页面，
// 除非调用方显式传 type，页面由此天然与文章流隔离。
export async function listPosts(db, { status = 'published', type = 'post', cat, tag, q, inNav, page = 1, per = 8 } = {}) {
  const { posts, cats, tags, pt, catById } = await loadTaxonomy(db);

  let list = posts.filter((p) => {
    if (status && status !== 'all' && p.status !== status) return false;
    if (type && type !== 'all' && (p.type === 'page' ? 'page' : 'post') !== type) return false;
    // 老数据没有 in_nav 字段，按「进导航」处理，与 SQL 版列默认值 1 一致
    if (inNav && !(Number(p.in_nav == null ? 1 : p.in_nav))) return false;
    if (cat) {
      const c = cats.find((x) => x.slug === cat);
      // 查不到这个分类就返回空，绝不能退化成「不过滤」把所有文章都列出来
      if (!c) return false;
      // 顶级分类页要把它的二级分类的文章一起带出来（二级分类已封顶，不会再有下级）
      const hit = eqId(p.category_id, c.id)
        || cats.some((k) => eqId(k.parent_id, c.id) && eqId(p.category_id, k.id));
      if (!hit) return false;
    }
    if (tag) {
      const t = tags.find((x) => x.slug === tag);
      if (!t) return false;
      if (!pt.some((x) => eqId(x.tag_id, t.id) && eqId(x.post_id, p.id))) return false;
    }
    if (q) {
      // 等价于原来的 title LIKE %q% OR excerpt LIKE %q%（escLike 已把通配符转义成字面量）
      const n = String(q).toLowerCase();
      const hit = String(p.title || '').toLowerCase().includes(n)
        || String(p.excerpt || '').toLowerCase().includes(n);
      if (!hit) return false;
    }
    return true;
  });

  // ORDER BY COALESCE(published_at, updated_at) DESC
  const key = (p) => p.published_at || p.updated_at || '';
  list = list.slice().sort((a, b) => (key(b) > key(a) ? 1 : key(b) < key(a) ? -1 : 0));

  const total = list.length;
  const pg = paginate(page, per, total);
  const items = list.slice(pg.offset, pg.offset + per).map((p) => rowOf(p, catById, tags, pt));
  return { items, total, page: pg.p, pages: pg.pages, per };
}

export async function getPost(db, { id, slug } = {}) {
  const { posts, tags, pt, catById } = await loadTaxonomy(db);
  const p = id != null ? posts.find((x) => eqId(x.id, id)) : posts.find((x) => x.slug === slug);
  if (!p) return null;
  const post = rowOf(p, catById, tags, pt);
  // 详情页才需要正文，这里单独取一次
  const body = await db.readBody(p.id);
  post.content_md = body && body.content_md != null ? body.content_md : '';
  post.content_html = body && body.content_html != null ? body.content_html : '';
  return post;
}

// 摘要缺省时从正文纯文本自动截取，保证列表页有内容可显示（列表页不读正文）
function autoExcerpt(f) {
  const html = f && f.content_html ? String(f.content_html) : '';
  return html ? stripHtml(html).slice(0, 260) : '';
}

export async function createPost(db, f) {
  const t = bnNow();
  const type = f.type === 'page' ? 'page' : 'post';
  const inNav = f.in_nav == null ? 1 : (f.in_nav ? 1 : 0);
  const id = await db.nextId('posts');
  const slug = await uniqueSlug(db, 'posts', slugify(f.slug) || ((type === 'page' ? 'page-' : 'post-') + id), id);
  const meta = {
    id,
    title: f.title,
    slug,
    type,
    in_nav: inNav,
    excerpt: f.excerpt || autoExcerpt(f),
    cover_key: f.cover_key || null,
    status: f.status || 'draft',
    category_id: f.category_id != null ? f.category_id : null,
    created_at: t,
    updated_at: t,
    published_at: f.status === 'published' ? (f.published_at || t) : null,
    comment_count: 0,
    word_count: String(f.content_md || '').length,
  };
  await db.mutate('posts', [], (rows) => { rows.push(meta); return rows; });
  await db.writeBody(id, { content_md: f.content_md || '', content_html: f.content_html || '' });
  if (f.tags && f.tags.length) await setPostTags(db, id, f.tags);
  return id;
}

export async function updatePost(db, id, f) {
  const rows = await db.read('posts');
  const old = rows.find((r) => eqId(r.id, id));
  if (!old) return false;
  const t = bnNow();
  const published_at = f.status === 'published'
    ? (old.published_at || f.published_at || t)
    : (f.status === 'draft' ? null : old.published_at);
  // 没传别名就保留原来的：以前会写进空串，既让地址变成 /post/，又会在下次保存时撞唯一性
  const type = f.type ? (f.type === 'page' ? 'page' : 'post') : (old.type === 'page' ? 'page' : 'post');
  // 别名被别人占了就追加序号（excludeId 传 id，避免把自己判成重名导致 xxx-2-2…）
  const slug = f.slug
    ? await uniqueSlug(db, 'posts', slugify(f.slug) || ((type === 'page' ? 'page-' : 'post-') + id), id)
    : old.slug;

  // 摘要与字数：优先用提交值，其次从正文重算，最后保留旧值 ——
  // 否则「只改标题、正文没跟着传」的请求会把摘要和字数清空。
  const excerpt = f.excerpt || autoExcerpt(f) || old.excerpt || '';
  const word_count = f.content_md != null ? String(f.content_md).length : (old.word_count || 0);

  await db.mutate('posts', [], (list) => {
    const x = list.find((r) => eqId(r.id, id));
    if (x) {
      x.title = f.title;
      x.slug = slug;
      x.excerpt = excerpt;
      x.cover_key = f.cover_key || null;
      x.status = f.status || old.status;
      x.category_id = f.category_id != null ? f.category_id : null;
      x.updated_at = t;
      x.published_at = published_at;
      x.word_count = word_count;
      // type / in_nav 只在调用方显式传了才更新：文章编辑接口不传，就不会把文章改成页面
      x.type = type;
      if (f.in_nav != null) x.in_nav = f.in_nav ? 1 : 0;
      else if (x.in_nav == null) x.in_nav = old.in_nav == null ? 1 : old.in_nav;
    }
    return list;
  });
  await db.writeBody(id, { content_md: f.content_md || '', content_html: f.content_html || '' });
  if (f.tags) await setPostTags(db, id, f.tags);
  return true;
}

export async function deletePost(db, id) {
  await db.mutate('comments', [], (cs) => cs.filter((c) => !eqId(c.post_id, id)));
  await db.mutate('post_tags', [], (pt) => pt.filter((x) => !eqId(x.post_id, id)));
  await db.mutate('posts', [], (ps) => ps.filter((p) => !eqId(p.id, id)));
  await db.dropBody(id);
}

// 仅切换发布/下线状态（不触碰正文，保留首次发布时间）
export async function setPostStatus(db, id, status) {
  const rows = await db.read('posts');
  const old = rows.find((r) => eqId(r.id, id));
  if (!old) return false;
  const t = bnNow();
  const published_at = status === 'published' ? (old.published_at || t) : null;
  await db.mutate('posts', [], (list) => {
    const x = list.find((r) => eqId(r.id, id));
    if (x) { x.status = status; x.published_at = published_at; x.updated_at = t; }
    return list;
  });
  return true;
}

// 上一篇 / 下一篇（按发布时间）
export async function siblings(db, post) {
  if (!post.published_at) return { prev: null, next: null };
  const [posts, cats] = await Promise.all([db.read('posts'), db.read('categories')]);
  const catById = new Map(cats.map((c) => [num(c.id), c]));
  // 页面（type=page）不参与上一篇 / 下一篇，这里与调用处双重限定
  const live = posts.filter((p) => p.status === 'published' && p.type !== 'page' && p.published_at);
  const older = live.filter((p) => p.published_at < post.published_at)
    .sort((a, b) => (a.published_at < b.published_at ? 1 : -1));   // 时间倒序，取第一条 = 更早的那篇
  const newer = live.filter((p) => p.published_at > post.published_at)
    .sort((a, b) => (a.published_at < b.published_at ? -1 : 1));   // 时间正序，取第一条 = 更新的那篇
  const pick = (p) => (p
    ? { id: p.id, title: p.title, slug: p.slug, published_at: p.published_at, cat_slug: (catById.get(num(p.category_id)) || {}).slug }
    : null);
  return { prev: pick(older[0]), next: pick(newer[0]) };
}

// ---------- post_tags ----------
async function setPostTags(db, postId, names) {
  const seen = new Set();
  const wanted = [];
  for (const raw of names) {
    const name = String(raw || '').trim();
    if (!name || name.length > 20 || seen.has(name)) continue;
    seen.add(name);
    wanted.push(name);
  }
  await db.mutate('post_tags', [], (pt) => pt.filter((x) => !eqId(x.post_id, postId)));

  for (const name of wanted) {
    let tag = (await db.read('tags')).find((t) => t.name === name);
    if (!tag) {
      const t = bnNow();
      const slug = await uniqueSlug(db, 'tags', slugify(name) || ('tag-' + (Date.now() % 1000000)));
      const id = await db.nextId('tags');
      tag = { id, name, slug, created_at: t };
      await db.mutate('tags', [], (list) => { list.push(tag); return list; });
    }
    // 与 INSERT OR IGNORE 等价：已存在就不重复插
    await db.mutate('post_tags', [], (pt) => {
      if (!pt.some((x) => eqId(x.post_id, postId) && eqId(x.tag_id, tag.id))) {
        pt.push({ post_id: postId, tag_id: tag.id });
      }
      return pt;
    });
  }
}

// ---------- categories ----------
// 只支持两级：顶级（parent_id=0）与挂在顶级下的二级分类。
// 返回 full_slug（父/子）供前台拼地址；count 含二级分类的文章，与父分类页实际列出的数量一致。
export async function listCategories(db) {
  const [cats, posts] = await Promise.all([db.read('categories'), db.read('posts')]);
  const counts = new Map();
  for (const p of posts) {
    if (p.status === 'published' && p.category_id != null) {
      const k = num(p.category_id);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  const byId = new Map(cats.map((c) => [num(c.id), c]));
  const rows = cats.slice()
    // 与 SQL 版 ORDER BY parent_id ASC, id ASC 同序
    .sort((a, b) => (pidOf(a) - pidOf(b)) || (num(a.id) - num(b.id)))
    .map((c) => {
      const parent = pidOf(c) ? byId.get(pidOf(c)) : null;
      // 自己 + 自己的二级分类：父分类页会把子分类的文章一起列出来，数字必须对得上
      let n = counts.get(num(c.id)) || 0;
      for (const k of cats) if (eqId(k.parent_id, c.id)) n += counts.get(num(k.id)) || 0;
      return {
        ...c,
        parent_id: pidOf(c),
        parent_slug: parent ? parent.slug : '',
        parent_name: parent ? parent.name : '',
        in_nav: Number(c.in_nav) ? 1 : 0,
        count: n,
      };
    });
  for (const c of rows) c.full_slug = catFullSlug(c);
  return rows;
}
// 顶级分类在前、其下二级紧随其后，供后台列表与前台总览按树形渲染
export function treeCategories(list) {
  const tops = list.filter((c) => !pidOf(c));
  const out = [];
  for (const t of tops) {
    out.push(t);
    for (const c of list) if (eqId(c.parent_id, t.id)) out.push(c);
  }
  // 父分类被删掉而子分类还没清理的极端情况：别把孤儿藏起来
  for (const c of list) if (!out.includes(c)) out.push(c);
  return out;
}
// 导航栏要显示的分类：in_nav=1 的顶级分类，自带的二级分类挂在 children 里
// （二级分类不单独占导航位，只在父分类的下拉里出现）
export async function navCategories(db) {
  const all = await listCategories(db);
  return all
    .filter((c) => !pidOf(c) && Number(c.in_nav) === 1)
    .map((t) => ({ ...t, children: all.filter((c) => eqId(c.parent_id, t.id)) }));
}
// 只有顶级分类能当别人的上级；传进来的 id 无效或不是顶级就返回 0（降级为顶级，不报错）
async function topCategoryId(db, id, selfId) {
  const cats = await db.read('categories');
  const p = cats.find((c) => eqId(c.id, id));
  if (!p) return 0;
  if (selfId && eqId(p.id, selfId)) return 0;   // 不能挂到自己名下
  if (pidOf(p)) return 0;                       // 二级分类不能再有下级
  return p.id;
}
// 取单个分类（含归一化后的 parent_id / in_nav）：接口层校验「上级分类」时用。
// 单独抽出来是为了不为了查一行而把整站文章也读一遍（listCategories 会连 posts 一起读）
export async function getCategory(db, id) {
  const cats = await db.read('categories');
  const c = cats.find((x) => eqId(x.id, id)) || null;
  if (!c) return null;
  return { ...c, parent_id: pidOf(c), in_nav: Number(c.in_nav) ? 1 : 0 };
}
export async function createCategory(db, { name, slug, description, parent_id, in_nav }) {
  const t = bnNow();
  // 上级只能是顶级分类：这样天然不会出现三层，也不会成环
  const pid = parent_id ? await topCategoryId(db, parent_id) : 0;
  // 二级分类不占导航位（跟着父分类在下拉里出现），所以强制置 0，避免存了不生效的脏数据
  const nav = pid ? 0 : (in_nav ? 1 : 0);
  const finalSlug = await uniqueSlug(db, 'categories', slugify(slug || name) || ('cat-' + (Date.now() % 1000000)));
  const id = await db.nextId('categories');
  await db.mutate('categories', [], (list) => {
    list.push({
      id, name, slug: finalSlug, description: description || '',
      parent_id: pid, in_nav: nav, created_at: t,
    });
    return list;
  });
  return { id, slug: finalSlug, parent_id: pid, in_nav: nav };
}
export async function updateCategory(db, id, { name, slug, description, parent_id, in_nav }) {
  const cats = await db.read('categories');
  const cur = cats.find((c) => eqId(c.id, id)) || null;
  // 上级只接受「顶级分类」或「回到顶级」：传了非顶级就沿用原值
  const pid = parent_id ? await topCategoryId(db, parent_id, id)
    : (parent_id === 0 ? 0 : pidOf(cur));
  // 变成二级分类就自动退出导航栏；没传 in_nav 时保持原值
  const nav = pid ? 0 : (in_nav == null ? (Number(cur && cur.in_nav) ? 1 : 0) : (in_nav ? 1 : 0));
  // 必须传 excludeId=id：否则保存时自己的 slug 会被判成重名，别名被追加成 xxx-2，旧链接全部失效
  const finalSlug = await uniqueSlug(db, 'categories', slugify(slug || name) || ('cat-' + (Date.now() % 1000000)), id);
  await db.mutate('categories', [], (list) => {
    const c = list.find((x) => eqId(x.id, id));
    if (c) {
      c.name = name;
      c.slug = finalSlug;
      c.description = description || '';
      c.parent_id = pid;
      c.in_nav = nav;
    }
    return list;
  });
  // 回传最终别名：与提交值不同说明被别的分类占了，接口据此提示用户
  return finalSlug;
}
export async function deleteCategory(db, id) {
  // 删父不删子：子分类自动升为顶级，文章链接还留着，只是地址少了一层（路由会 301 过去）
  await db.mutate('categories', [], (list) => {
    for (const c of list) if (eqId(c.parent_id, id)) c.parent_id = 0;
    return list.filter((c) => !eqId(c.id, id));
  });
  await db.mutate('posts', [], (list) => {
    for (const p of list) if (eqId(p.category_id, id)) p.category_id = null;
    return list;
  });
}

// ---------- tags ----------
export async function listTags(db) {
  const [tags, pt, posts] = await Promise.all([db.read('tags'), db.read('post_tags'), db.read('posts')]);
  const live = new Set(posts.filter((p) => p.status === 'published').map((p) => num(p.id)));
  const counts = new Map();
  for (const x of pt) {
    if (!live.has(num(x.post_id))) continue;
    const k = num(x.tag_id);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return tags.slice().sort((a, b) => num(a.id) - num(b.id))
    .map((t) => ({ ...t, count: counts.get(num(t.id)) || 0 }));
}
export async function deleteTag(db, id) {
  await db.mutate('post_tags', [], (list) => list.filter((x) => !eqId(x.tag_id, id)));
  await db.mutate('tags', [], (list) => list.filter((t) => !eqId(t.id, id)));
}

// ---------- comments ----------
export async function listComments(db, { status, limit = 100, postId } = {}) {
  const [cmts, posts] = await Promise.all([db.read('comments'), db.read('posts')]);
  const pById = new Map(posts.map((p) => [num(p.id), p]));
  let list = cmts;
  if (status && status !== 'all') list = list.filter((c) => c.status === status);
  if (postId) list = list.filter((c) => eqId(c.post_id, postId));
  list = list.slice().sort((a, b) => num(b.id) - num(a.id)).slice(0, limit);
  return list.map((c) => {
    const p = pById.get(num(c.post_id));
    return { ...c, post_title: p ? p.title : null, post_slug: p ? p.slug : null };
  });
}
export async function countPending(db) {
  const cs = await db.read('comments');
  return cs.filter((c) => c.status === 'pending').length;
}
export async function getComment(db, id) {
  const cs = await db.read('comments');
  return cs.find((c) => eqId(c.id, id)) || null;
}
// 文章已过审评论（含博主回复）
export async function commentsForPost(db, postId) {
  const cs = await db.read('comments');
  return cs
    .filter((c) => eqId(c.post_id, postId) && c.status === 'approved')
    .sort((a, b) => num(a.id) - num(b.id))
    .map((c) => ({
      id: c.id, parent_id: c.parent_id, author: c.author, email: c.email,
      website: c.website, content: c.content, is_admin: c.is_admin, created_at: c.created_at,
    }));
}

// 评论数冗余在文章元数据里，任何影响「已过审评论」数量的操作都要同步
async function bumpCommentCount(db, postId, delta) {
  if (!delta) return;
  await db.mutate('posts', [], (list) => {
    const p = list.find((x) => eqId(x.id, postId));
    if (p) p.comment_count = Math.max(0, (Number(p.comment_count) || 0) + delta);
    return list;
  });
}

export async function addComment(db, { postId, parentId = null, author, email, website = '', content, status, isAdmin = 0, ip }) {
  const t = bnNow();
  const id = await db.nextId('comments');
  const row = {
    id, post_id: postId, parent_id: parentId, author,
    email: email || '', website: website || '', content,
    status, is_admin: isAdmin, ip: ip || '', created_at: t,
  };
  await db.mutate('comments', [], (list) => { list.push(row); return list; });
  if (status === 'approved') await bumpCommentCount(db, postId, 1);
  return id;
}
export async function setCommentStatus(db, id, status) {
  const cs = await db.read('comments');
  const cur = cs.find((c) => eqId(c.id, id));
  if (!cur) return;
  const was = cur.status;
  await db.mutate('comments', [], (list) => {
    const c = list.find((x) => eqId(x.id, id));
    if (c) c.status = status;
    return list;
  });
  if (was !== status) {
    const delta = (status === 'approved' ? 1 : 0) - (was === 'approved' ? 1 : 0);
    await bumpCommentCount(db, cur.post_id, delta);
  }
}
export async function deleteComment(db, id) {
  const cs = await db.read('comments');
  // 与 DELETE ... WHERE id=? OR parent_id=? 等价：删主评论时连带删掉它的回复
  const gone = cs.filter((c) => eqId(c.id, id) || eqId(c.parent_id, id));
  const byPost = new Map();
  for (const c of gone) {
    if (c.status === 'approved') byPost.set(num(c.post_id), (byPost.get(num(c.post_id)) || 0) + 1);
  }
  await db.mutate('comments', [], (list) => list.filter((c) => !eqId(c.id, id) && !eqId(c.parent_id, id)));
  for (const [pid, n] of byPost) await bumpCommentCount(db, pid, -n);
}
export async function recentCommentsByIp(db, ip, seconds = 60) {
  const cutoff = new Date(Date.now() + 8 * 3600e3 - seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const cs = await db.read('comments');
  // created_at 是北京时间字符串，可直接比大小；'ip' 未取到时与写入时一致地落成 '-'
  return cs.filter((c) => (c.ip || '-') === (ip || '-') && c.created_at > cutoff).length;
}

// ---------- 统计 ----------
export async function stats(db) {
  const [posts, cats, tags, cmts] = await Promise.all([
    db.read('posts'), db.read('categories'), db.read('tags'), db.read('comments'),
  ]);
  // 文章数与页面数分开统计：仪表盘「文章 N 篇」不该把「关于我」这类页面算进去
  const isPage = (p) => p.type === 'page';
  const by = (s) => posts.filter((p) => !isPage(p) && p.status === s).length;
  return {
    posts: posts.filter((p) => !isPage(p)).length,
    published: by('published'),
    drafts: by('draft'),
    pages: posts.filter(isPage).length,
    categories: cats.length,
    tags: tags.length,
    comments: cmts.length,
    pending: cmts.filter((c) => c.status === 'pending').length,
  };
}

// 仪表盘用的聚合（原先散在路由层当裸 SQL 写，收编到这里）
//  - words        全部文章 Markdown 字数之和（用元数据里的 word_count，不读正文）
//  - month_posts  本月新建文章数
//  - month_comments 本月新评论数
// monthStart 形如 '2026-09-01'，与 created_at 的北京时间字符串可直接比大小
export async function dashboardAggregates(db, monthStart) {
  const [posts, cmts] = await Promise.all([db.read('posts'), db.read('comments')]);
  const since = String(monthStart || '');
  return {
    words: posts.reduce((n, p) => n + (Number(p.word_count) || 0), 0),
    month_posts: posts.filter((p) => String(p.created_at || '') >= since).length,
    month_comments: cmts.filter((c) => String(c.created_at || '') >= since).length,
  };
}

// ---------- 友情链接 ----------
// Blob 版没有 DDL，这个函数保留为空实现，只为兼容既有调用点。
export const LINK_STATUS = ['pending', 'approved', 'rejected'];
export async function ensureLinkTable() { /* Blob 无需建表 */ }

const LINK_COLS = ['id', 'name', 'url', 'description', 'logo', 'contact', 'reason', 'sort', 'status', 'source', 'created_at', 'updated_at'];
const linkOut = (l) => {
  const o = {};
  for (const k of LINK_COLS) o[k] = l[k];
  return o;
};
// 与 ORDER BY sort ASC, id DESC 等价
const bySort = (a, b) => ((num(a.sort) || 0) - (num(b.sort) || 0)) || (num(b.id) - num(a.id));

export async function listLinks(db, { status = 'approved' } = {}) {
  const all = await db.read('links');
  const list = status && status !== 'all' ? all.filter((l) => l.status === status) : all;
  return list.slice().sort(bySort).map(linkOut);
}
export async function countLinksByStatus(db) {
  const all = await db.read('links');
  const out = { pending: 0, approved: 0, rejected: 0 };
  for (const l of all) if (l.status in out) out[l.status] += 1;
  return out;
}
export async function getLink(db, id) {
  const all = await db.read('links');
  const l = all.find((x) => eqId(x.id, id));
  return l ? linkOut(l) : null;
}
// 同网址重复申请/重复添加要挡住（忽略协议与末尾斜杠差异）
export async function findLinkByUrl(db, url) {
  const all = await db.read('links');
  const norm = String(url || '').trim().replace(/\/+$/, '');
  const hit = all.find((x) => String(x.url).trim().replace(/\/+$/, '') === norm);
  return hit ? linkOut(hit) : null;
}
export async function addLink(db, d) {
  const now = bnNow();
  const id = await db.nextId('links');
  await db.mutate('links', [], (list) => {
    list.push({
      id, name: d.name, url: d.url,
      description: d.description || '', logo: d.logo || '',
      contact: d.contact || '', reason: d.reason || '',
      sort: num(d.sort) || 0, status: d.status || 'pending',
      source: d.source || 'admin', ip: d.ip || '',
      created_at: now, updated_at: now,
    });
    return list;
  });
  return id;
}
export async function updateLink(db, id, patch) {
  const allow = ['name', 'url', 'description', 'logo', 'contact', 'reason', 'sort', 'status'];
  const keys = Object.keys(patch || {}).filter((k) => allow.includes(k));
  if (!keys.length) return 0;
  // status 走白名单，避免把非法值写进去
  if (keys.includes('status') && !LINK_STATUS.includes(patch.status)) return 0;
  const now = bnNow();
  await db.mutate('links', [], (list) => {
    const l = list.find((x) => eqId(x.id, id));
    if (l) {
      for (const k of keys) l[k] = patch[k];
      l.updated_at = now;
    }
    return list;
  });
  return 1;
}
export async function deleteLink(db, id) {
  await db.mutate('links', [], (list) => list.filter((l) => !eqId(l.id, id)));
}
export async function recentLinkApplies(db, ip, seconds = 3600) {
  const cutoff = new Date(Date.now() + 8 * 3600e3 - seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const all = await db.read('links');
  return all.filter((l) => l.source === 'apply' && (l.ip || '-') === (ip || '-') && l.created_at > cutoff).length;
}

// 独立页面（type='page'）：前台导航、站点地图与后台「页面」列表都走这里
export async function listPages(db, { status = 'published', inNav = false } = {}) {
  const r = await listPosts(db, { status, type: 'page', inNav, per: 200 });
  return r.items;
}

// ---------- 归档 / 全量导出（备份用） ----------
export async function archivePosts(db) {
  const [posts, cats] = await Promise.all([db.read('posts'), db.read('categories')]);
  const catById = new Map(cats.map((c) => [num(c.id), c]));
  return posts
    // 只归档文章：页面没有发布时间概念，混进来会变成一堆无日期条目
    .filter((p) => p.status === 'published' && p.type !== 'page')
    .slice()
    .sort((a, b) => ((a.published_at || '') < (b.published_at || '') ? 1 : -1))
    // 带分类别名：永久链接用到 {category} 时归档页也要能拼出正确地址
    .map((p) => ({
      id: p.id, title: p.title, slug: p.slug, published_at: p.published_at,
      cat_slug: (catById.get(num(p.category_id)) || {}).slug,
    }));
}

export async function dumpAll(db) {
  const [settings, categories, tags, posts, post_tags, comments, links] = await Promise.all([
    db.read('settings', 'map'),
    db.read('categories'), db.read('tags'), db.read('posts'),
    db.read('post_tags'), db.read('comments'), db.read('links'),
  ]);
  // 正文单独存文件，导出时拼回 posts —— 备份文件的 JSON 结构与 Cloudflare 版
  // 完全一致（仅少了 pv_daily，那部分统计功能已移除），旧站备份可直接导入。
  const bodies = await Promise.all(posts.map((p) => db.readBody(p.id)));
  const fullPosts = posts.map((p, i) => ({
    ...p,
    content_md: bodies[i] && bodies[i].content_md != null ? bodies[i].content_md : '',
    content_html: bodies[i] && bodies[i].content_html != null ? bodies[i].content_html : '',
  }));
  return {
    exported_at: bnNow(),
    settings: Object.entries(settings).map(([key, value]) => ({ key, value })),
    categories,
    tags,
    posts: fullPosts,
    post_tags,
    comments,
    links,
  };
}

// 恢复：整体覆盖。先清空语义由「整份写入」天然满足。
export async function restoreAll(db, data) {
  const d = data || {};
  const curSettings = await db.read('settings', 'map');
  const next = {};
  // 管理员凭据不从备份恢复：备份里是旧站账号，导入会覆盖新站刚设好的登录信息
  for (const k of Object.keys(curSettings)) if (/^admin_/.test(k)) next[k] = curSettings[k];
  for (const s of (d.settings || [])) {
    if (s && s.key && !/^admin_/.test(s.key)) next[s.key] = String(s.value ?? '');
  }

  const rawPosts = d.posts || [];
  const metas = rawPosts.map((p) => {
    const meta = { ...p };
    delete meta.content_md;
    delete meta.content_html;
    // 兼容老备份（Ver 0.4 之前导出的没有这几个字段）：就地把默认值补齐。
    // 漏补的后果很安静 —— 页面会被当成文章混进首页，分类层级整个消失。
    meta.type = meta.type === 'page' ? 'page' : 'post';
    meta.in_nav = meta.in_nav == null ? 1 : (meta.in_nav ? 1 : 0);
    return meta;
  });
  // 分类同理：老备份没有 parent_id / in_nav，缺了就按「顶级、不进导航」补齐
  const categories = (d.categories || []).map((c) => ({
    ...c,
    parent_id: pidOf(c),
    in_nav: Number(c.in_nav) ? 1 : 0,
  }));
  const comments = d.comments || [];
  // 兼容旧备份：老库没有 comment_count / word_count 字段，这里就地补算，
  // 否则列表页的「N 评论」会全显示 0
  const cnt = new Map();
  for (const c of comments) {
    if (c.status === 'approved') cnt.set(num(c.post_id), (cnt.get(num(c.post_id)) || 0) + 1);
  }
  metas.forEach((m, i) => {
    m.comment_count = cnt.get(num(m.id)) || 0;
    if (m.word_count == null) m.word_count = String(rawPosts[i].content_md || '').length;
    if (m.excerpt == null) m.excerpt = '';
  });

  await db.write('settings', next);
  await db.write('categories', categories);
  await db.write('tags', d.tags || []);
  await db.write('posts', metas);
  await db.write('post_tags', d.post_tags || []);
  await db.write('comments', comments);
  await db.write('links', d.links || []);
  // ★ 自增游标必须抬到已有 id 的最大值：Blob 没有 AUTOINCREMENT，
  //   不这么做的话「恢复备份后新建文章」会拿到 id=1，与恢复出来的数据撞号。
  await db.write('seq', {
    posts: maxId(metas),
    comments: maxId(comments),
    tags: maxId(d.tags || []),
    categories: maxId(categories),
    links: maxId(d.links || []),
  });
  await db.writeBodies(rawPosts.map((p) => [p.id, { content_md: p.content_md || '', content_html: p.content_html || '' }]));
  return metas.length;
}
