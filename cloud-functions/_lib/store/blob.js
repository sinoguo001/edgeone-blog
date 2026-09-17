// ============================================================
// R2 兼容层：把 Cloudflare R2 的对象接口映射到 EdgeOne Blob 存储
//
// 项目里实际用到的 R2 能力只有 5 个：get / put / delete / list / head
//   get    -> store.get(key, { type: 'stream' })    二进制安全
//   put    -> store.set(key, value)
//   delete -> store.delete(key)
//   list   -> store.list({ prefix, cursor, limit })
//   head   -> store.list({ prefix: key, limit: 1 }) 精确比对，
//             避免为了「判断备份是否存在」而把整个备份下载一遍
//
// ⚠️ Blob 不提供自定义元数据（R2 的 customMetadata 没有对应物），
//   所以 content-type 一律按 key 的扩展名推断。这与上传逻辑天然一致 ——
//   上传时正是用 content-type 反查扩展名来生成 key 的，两者必然吻合。
// ============================================================
// ⚠️ 该 SDK 目前还是 0.0.x，其 package.json 未声明 "type": "module"，
// 命名导出能否被 ESM 直接解构，取决于它最终打出的是 CJS 还是 ESM。
// 这里用「命名空间导入 + 兜底 default」的写法，两种形态都能跑通。
import * as blobSdk from '@edgeone/pages-blob';
import { mimeOfExt } from '../util.js';

const getStore = blobSdk.getStore || (blobSdk.default && blobSdk.default.getStore);

// 从 key 里还原上传时刻 —— R2 原本会返回 uploaded 字段，Blob 的 list()
// 只给 { key, etag }，所以只能从命名规则反推。项目里有两套命名：
//   备份：backups/backup-20260914153000-ab12.json  → 14 位「北京时间」日期时间
//   媒体：media/1757881234567-ab12.png             → 13 位 epoch 毫秒（Date.now()）
// 两种都要认，否则后台媒体列表的「上传时间」会全是 0、排序也就失了依据。
function uploadedFromKey(key) {
  const k = key || '';
  const d = /-(\d{14})-/.exec(k);
  if (d) {
    const s = d[1];
    const t = Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}+08:00`);
    if (t) return t;
  }
  const m = /(\d{13})/.exec(k);
  if (m) return Number(m[1]) || 0;
  return 0;
}

function normBlob(b) {
  if (typeof b === 'string') {
    return { key: b, size: 0, uploaded: uploadedFromKey(b), customMetadata: {} };
  }
  const key = b.key || b.name || b.path || '';
  const rawSize = b.size != null ? b.size : (b.length != null ? b.length : 0);
  const rawTs = b.uploaded || b.uploadedAt || b.lastModified || b.mtime || 0;
  return {
    key,
    size: Number(rawSize) || 0,
    uploaded: Number(rawTs) || uploadedFromKey(key),
    customMetadata: b.customMetadata || {},
  };
}

// 文本类走 text 模式（可立刻 .json()），二进制走 stream（避免被 UTF-8 解码损坏）
const TEXTY = /\.(json|css|js|mjs|txt|svg|html|xml)$/i;

class ObjectBody {
  constructor(bucket, key, body, text) {
    this.bucket = bucket;
    this.key = key;
    this.body = body;
    this._text = text;
    this.httpEtag = '';
    const ct = mimeOfExt(key);
    this.httpMetadata = { contentType: ct };
    this.customMetadata = { ct };
  }

  async text() {
    if (this._text != null) return this._text;
    return await this.bucket.store.get(this.key, { type: 'text' });
  }

  async json() {
    return JSON.parse(await this.text());
  }

  async arrayBuffer() {
    if (this._text != null) return new TextEncoder().encode(this._text).buffer;
    return await this.bucket.store.get(this.key, { type: 'arrayBuffer' });
  }
}

class Bucket {
  constructor(store) {
    this.store = store;
  }

  async get(key) {
    if (TEXTY.test(key)) {
      const t = await this.store.get(key, { type: 'text' });
      if (t == null) return null;
      return new ObjectBody(this, key, String(t), String(t));
    }
    const s = await this.store.get(key, { type: 'stream' });
    if (s == null) return null;
    return new ObjectBody(this, key, s, null);
  }

  async head(key) {
    const r = await this.store.list({ prefix: key, limit: 1 });
    const first = (r.blobs || r.keys || r.objects || [])[0];
    if (!first) return null;
    const o = normBlob(first);
    return o.key === key ? { key, size: o.size, uploaded: o.uploaded } : null;
  }

  async put(key, value) {
    // request.body 是 ReadableStream。Blob 的 set() 虽声明支持 stream，
    // 但转成 ArrayBuffer 更稳 —— 上传受 6MB 请求体上限约束，这点内存开销可忽略。
    let v = value;
    if (value && typeof value.getReader === 'function') {
      v = await new Response(value).arrayBuffer();
    }
    await this.store.set(key, v);
    return { key };
  }

  async delete(key) {
    await this.store.delete(key);
  }

  async list(opts = {}) {
    const r = await this.store.list({
      prefix: opts.prefix,
      cursor: opts.cursor,
      limit: opts.limit,
    });
    const arr = r.blobs || r.keys || r.objects || [];
    return {
      objects: arr.map(normBlob),
      truncated: !!r.truncated,
      cursor: r.cursor,
    };
  }
}

export function openR2(name) {
  // 一律用强一致：本博客写入频率极低，
  // 宁愿每次多花几毫秒，也不要出现「刚上传的图片 / 刚启用的主题读不到」。
  const store = getStore({ name: name || 'blog-assets', consistency: 'strong' });
  return new Bucket(store);
}
