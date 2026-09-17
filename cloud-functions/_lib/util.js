// ============ 通用小工具（Worker 端） ============
export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export const err = (msg, status = 400) => json({ error: msg }, status);

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);

export function stripHtml(h) {
  return String(h || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

// 北京时间（UTC+8）字符串 'YYYY-MM-DD HH:MM:SS'
export const bnNow = () => {
  const d = new Date(Date.now() + 8 * 3600e3);
  return d.toISOString().slice(0, 19).replace('T', ' ');
};

export function fmtDate(s, time = false) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?/.exec(s || '');
  if (!m) return '';
  return time ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : `${m[1]}-${m[2]}-${m[3]}`;
}

const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// 北京时间字符串 -> RFC1123（RSS 用）
export function rfc822(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s || '');
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return `${DOW[d.getUTCDay()]}, ${String(d.getUTCDate()).padStart(2,'0')} ${MON[d.getUTCMonth()]} ${m[1]} ${m[4]}:${m[5]}:${m[6]} +0800`;
}

// 只保留 ascii 小写英文/数字 slug（中文标题留空走 "post-id" 自动别名）
export const slugify = (s) =>
  String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// LIKE 通配符转义
export function escLike(s) {
  return String(s || '').replace(/[\\%_]/g, (c) => '\\' + c);
}

export function readCookie(req, name) {
  const m = new RegExp('(?:^|;\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)').exec(req.headers.get('cookie') || '');
  return m ? decodeURIComponent(m[1]) : null;
}

export const MIME_EXT = { png:'image/png', jpeg:'image/jpeg', jpg:'image/jpeg', gif:'image/gif',
  webp:'image/webp', avif:'image/avif', bmp:'image/bmp', ico:'image/x-icon', json:'application/json', txt:'text/plain',
  css:'text/css', svg:'image/svg+xml', woff2:'font/woff2', woff:'font/woff', xml:'application/xml', js:'application/javascript', webmanifest:'application/manifest+json' };
export const mimeOfExt = (f) => {
  const e = (String(f).split('.').pop() || '').toLowerCase();
  return MIME_EXT[e] || 'application/octet-stream';
};

export function paginate(page, per, total) {
  const pages = Math.max(1, Math.ceil(total / per));
  const p = Math.min(Math.max(1, page || 1), pages);
  return { p, pages, offset: (p - 1) * per };
}

export async function readJson(req) {
  try { return await req.json(); } catch (e) { return null; }
}

export const isHexColor = (s) => /^#[0-9a-fA-F]{6}$/.test(s || '');

// 邮箱格式校验（只管格式，不验证是否真实存在、也不发验证邮件）
// 要求：本地部分不含空格与 @；域名各级以字母数字开头结尾（`-b.com` 这类不合法）、至少含一个点、顶级域 2 位以上字母
export const isEmail = (s) =>
  /^[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/.test(String(s || '').trim());

// 后台异步任务：用于「邮件通知」这类不该拖慢响应、又需要在请求结束后继续跑的工作。
// ★ EdgeOne 的 Cloud Functions 文档里，EventContext 只列了
//   uuid / params / env / clientIp / server / geo，并未列出 waitUntil
//   （那是边缘函数 Pages Functions 才明确声明的字段）。因此这里不能直接
//   调 ctx.waitUntil(...)：平台支持就用（异步任务能跟着请求生命周期跑完），
//   不支持就退化成「不等待的后台 Promise」，两条路都不会让请求失败。
//   两种情形都必须吞掉 rejection —— 邮件发失败不能影响读者提交评论的结果。
export function bgTask(ctx, task) {
  // 交给平台的必须是「原始 Promise」—— 若换成 Promise.resolve(task).catch(...) 之类
  // 的包装，会平白多一个微任务跳，异步任务的落点会后移（已实测：会让调用方的
  // 「异步已触发」断言在采集窗口内看不到日志）。rejection 单独挂一个 catch 吞掉即可，
  // 不必改变交给平台的那个对象。
  const p = Promise.resolve(task);
  p.catch(() => {});
  try {
    if (ctx && typeof ctx.waitUntil === 'function') { ctx.waitUntil(p); return; }
  } catch (e) { /* 平台不接受该参数时忽略，直接走下面的降级路径 */ }
}

// RSS / Sitemap「双形态」判别：浏览器直接打开 -> 排版 HTML；阅读器 / 爬虫 -> 标准 XML。
//
// ★ 坑（上一版栽过）：真实浏览器的 Accept 长这样
//     text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8
//   里面**本来就有 application/xml**。所以绝不能拿「Accept 声明了 xml」当作「不是浏览器」的依据，
//   否则所有真实浏览器都会被误判成阅读器，HTML 分支永远走不到。
//   可靠信号是：浏览器一定声明 text/html 且 UA 带 Mozilla；而 RSS 阅读器只声明
//   application/rss+xml / application/xml，且 UA 是程序名。
const FEED_BOT_UA = /(?:bot\b|spider|crawl|slurp|feedfetcher|feedly|inoreader|newsblur|netnewswire|reeder|feedbin|theoldreader|rss(?:reader|parrot)?\b|validator|python-requests|python-urllib|\bcurl\b|\bwget\b|okhttp|java\/|go-http|libwww-perl|ahrefs|semrush|pingdom|monitoring|preview|headless)/i;

export function wantsFeedHtml(accept, ua, fmt) {
  if (fmt === 'html') return true;   // ?format=html 强制
  if (fmt === 'xml') return false;   // ?format=xml 强制（逃生舱）
  const a = String(accept || '');
  const u = String(ua || '');
  if (FEED_BOT_UA.test(u)) return false;                     // 爬虫 / 阅读器：一律 XML，保 SEO 与订阅
  if (/application\/(?:rss|atom)\+xml/i.test(a)) return false; // 显式声明订阅类型
  return /text\/html/i.test(a) && /Mozilla/i.test(u);        // 真浏览器
}

// ---------- 永久链接（伪静态 / permalink） ----------
// 规则形如 /post/{slug}.html，可用变量：{slug} {id} {year} {month} {day} {category}。
// {slug} 与 {id} 至少有一个，否则多篇会撞到同一个地址、无法反查。
export const PERMALINK_DEFAULT = '/post/{slug}';
export const PERMALINK_VARS = ['slug', 'id', 'year', 'month', 'day', 'category'];
// 首段是"字面量"时不能占用这些系统路径：固定路由先于永久链接匹配，占了文章就永远打不开
const PERMALINK_RESERVED = new Set([
  'api', 'admin', 'media', 'theme-assets', 'backup', 'backups', 'preview',
  'category', 'categories', 'tag', 'tags', 'archive', 'search',
  'links', 'page', 'js', 'rss.xml', 'feed.xml', 'sitemap.xml', 'robots.txt',
  'favicon.svg', 'favicon.ico', 'p',   // p = 独立页面前缀 /p/<slug>，不能被文章规则占用
]);

// 规整并校验；不合法返回 ''（调用方据此保留原值或报错）
export function normalizePermalink(v) {
  let x = String(v == null ? '' : v).trim();
  if (!x) return '';
  if (x[0] !== '/') x = '/' + x;
  x = x.replace(/\/{2,}/g, '/');                 // 去掉空段
  if (x.length > 1) x = x.replace(/\/+$/, '');   // 去掉末尾斜杠
  if (!x || x.length > 120) return '';
  // 只允许路径安全字符与 {变量}：挡掉空格、中文、? # : 等会破坏 URL 的字符
  if (!/^[A-Za-z0-9\-_.~/{}]+$/.test(x)) return '';
  if (!/\{(slug|id)\}/.test(x)) return '';                                  // 必须能唯一定位
  const used = [...x.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]);
  if (used.some((k) => !PERMALINK_VARS.includes(k))) return '';             // 未知变量
  if (new Set(used).size !== used.length) return '';                        // 同一变量出现两次
  const first = x.split('/')[1] || '';
  if (first && !first.includes('{') && PERMALINK_RESERVED.has(first)) return '';
  return x;
}

// 从设置里取规则；没设过或非法则回退默认，保证前台永远能出链接
export function permalinkOf(s) {
  const v = s && typeof s.get === 'function' ? s.get('permalink') : '';
  return normalizePermalink(v) || PERMALINK_DEFAULT;
}

const RE_ESC = /[.*+?^${}()|[\]\\]/g;
// 规则 → 正则 + 变量名顺序（用于把请求路径反解回文章）
export function permalinkRegex(pat) {
  const keys = [];
  let src = '';
  const RX = /\{(slug|id|year|month|day|category)\}|[^{]+|\{/g;
  let m;
  while ((m = RX.exec(pat))) {
    if (m[1]) {
      keys.push(m[1]);
      if (m[1] === 'id') src += '(\\d+)';
      else if (m[1] === 'year') src += '(\\d{4})';
      else if (m[1] === 'month' || m[1] === 'day') src += '(\\d{2})';
      else src += '([^/]+)';
    } else if (m[0] === '{') {
      src += '\\{';                       // 单个左花括号（非变量）按字面处理
    } else {
      src += m[0].replace(RE_ESC, '\\$&');
    }
  }
  return { re: new RegExp('^' + src + '$'), keys };
}

// 文章各变量的取值，用于生成链接与校验 URL 是否与文章一致
export function permalinkVars(p) {
  const d = String((p && (p.published_at || p.created_at)) || '').slice(0, 10);
  return {
    slug: String((p && p.slug) || ''),
    id: String((p && p.id) || ''),
    year: d.slice(0, 4),
    month: d.slice(5, 7),
    day: d.slice(8, 10),
    category: (p && p.category && p.category.slug) || (p && p.cat_slug) || 'uncategorized',
  };
}

// 生成文章的访问地址（相对路径，模板里再 esc 后写入 href）
export function postUrl(s, p) {
  const pat = permalinkOf(s);
  const v = permalinkVars(p);
  return pat.replace(/\{(slug|id|year|month|day|category)\}/g, (_, k) => v[k] || (k === 'category' ? 'uncategorized' : ''));
}

// 反解出来的变量是否与文章一致（文章改过发布时间或分类时，旧地址应 301 到新地址）
export function permalinkVarsMatch(kv, p) {
  const v = permalinkVars(p);
  for (const k of Object.keys(kv)) {
    if (kv[k] == null) continue;
    if (String(kv[k]) !== v[k]) return false;
  }
  return true;
}

// 分类地址（Ver 0.4 二级分类）：顶级 /category/别名，二级 /category/父别名/子别名
// 优先用 full_slug（父/子），没有就退回自己的别名
export function catUrl(c) {
  const s = (c && (c.full_slug || c.slug)) || '';
  return '/category/' + String(s).replace(/^\/+|\/+$/g, '');
}

// 独立页面（Ver 0.4）：地址固定为 /p/<slug>，不参与永久链接规则
export function pageUrl(p) {
  return '/p/' + String((p && p.slug) || '').replace(/^\/+|\/+$/g, '');
}
