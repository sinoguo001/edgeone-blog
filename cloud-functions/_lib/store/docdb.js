// ============================================================
// Blob 文档库：在 EdgeOne Blob 之上提供「集合式」数据访问
//
// 为什么不用 SQL：
//   平台自带的 Makers KV 只支持 Edge Functions，本项目跑在 Cloud Functions 上
//   用不了；能用的第一方存储只有 Blob。Blob 是对象存储、没有 SQL 引擎，
//   所以数据层改为「一个集合 = 一份 JSON 文档」，查询在 JS 里做。
//   官方对 Blob 的推荐场景本就包含「按目录组织的结构化数据集（多个 JSON）」。
//
// 为什么不用第三方数据库（Turso 等）：
//   一是数据要留在平台内，二是省掉一个外部依赖与一份要单独监控的免费额度。
//
// ── 数据布局（与 media/ backups/ 同库不同前缀，互不干扰）──
//   db/settings.json       {key: value}（map 形态，改单个键不必重写整个数组）
//   db/categories.json     [{id,name,slug,description,created_at}]
//   db/tags.json           [{id,name,slug,created_at}]
//   db/post_tags.json      [{post_id,tag_id}]
//   db/posts.json          文章「元数据」——列表页只读它
//   db/body/{id}.json      文章「正文」——详情页才读，避免列表页拖走全部正文
//   db/comments.json       [{...}]
//   db/links.json          [{...}]
//   db/seq.json            {posts:12, comments:34, ...} 各表自增游标
//
// ── 一致性 ──
//   底层 Bucket 以强一致模式打开（见 blob.js），写入后立刻能读到最新值。
//
// ── 并发 ──
//   Blob 没有 compare-and-swap，两个并发请求各自「读—改—写」会互相覆盖。
//   个人博客的写入几乎全部来自后台单人操作，唯一的前台写是评论提交，冲突概率极低；
//   这里再加一道进程内写锁，把同一实例内的并发写排队，把窗口收到最小。
//   ⚠️ 锁必须放在「模块作用域」：DocDb 是每请求新建的，挂在实例上的锁形同虚设。
//   读缓存则相反 —— 必须请求级隔离，否则会把上一个请求的数据带给下一个请求。
// ============================================================

const PREFIX = 'db/';
const BODY_PREFIX = 'db/body/';

// 模块级写锁：key 为文档名（或 'body:{id}'），保证同进程内同一份文档串行写
const locks = new Map();

function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  // 记进链尾时吞掉结果，避免前一个任务的失败被当成 unhandled rejection
  locks.set(key, next.then(() => {}, () => {}));
  return next;
}

export class DocDb {
  constructor(bucket) {
    this.bucket = bucket;
    this.cache = new Map();
  }

  // ---- 集合读写 ----

  // kind: 'list'（默认，返回数组）| 'map'（返回对象，如 settings / seq）
  async read(name, kind) {
    if (this.cache.has(name)) return this.cache.get(name);
    const v = await this._load(name, kind === 'map' ? 'map' : 'list');
    this.cache.set(name, v);
    return v;
  }

  async _load(name, kind) {
    let text = null;
    try {
      const obj = await this.bucket.get(PREFIX + name + '.json');
      if (obj) text = await obj.text();
    } catch (e) {
      // 单份文档读失败（网络抖动等）不应让整个页面 500：当作空集合继续
      console.error('doc read fail:', name, e && e.message);
      text = null;
    }
    if (text == null || text === '') return kind === 'map' ? {} : [];
    try {
      const v = JSON.parse(text);
      if (kind === 'map') return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
      return Array.isArray(v) ? v : [];
    } catch (e) {
      console.error('doc parse fail:', name, e && e.message);
      return kind === 'map' ? {} : [];
    }
  }

  async write(name, doc) {
    await this.bucket.put(PREFIX + name + '.json', JSON.stringify(doc));
    this.cache.set(name, doc);
    return doc;
  }

  // 读最新 → 交给 fn 修改 → 写回。fn 返回 undefined 表示「就地改传入对象」
  async mutate(name, def, fn) {
    return withLock(name, async () => {
      // 关键：这里绕开缓存，强制取最新副本，否则会拿旧快照覆盖别人的写入
      this.cache.delete(name);
      const cur = await this._load(name, Array.isArray(def) ? 'list' : 'map');
      const next = await fn(cur);
      const out = next === undefined ? cur : next;
      await this.bucket.put(PREFIX + name + '.json', JSON.stringify(out));
      this.cache.set(name, out);
      return out;
    });
  }

  async drop(name) {
    await this.bucket.delete(PREFIX + name + '.json');
    this.cache.delete(name);
  }

  // 自增 id：所有表的 id 都从这里取，避免各表自己维护计数器导致撞号
  async nextId(table) {
    const s = await this.mutate('seq', {}, (cur) => {
      cur[table] = (Number(cur[table]) || 0) + 1;
      return cur;
    });
    return Number(s[table]) || 1;
  }

  // ---- 文章正文（单独成文件）----
  // 列表 / 归档 / 搜索只需要元数据，正文动辄几十 KB，
  // 混在同一份文档里会让每次列表页都白白下载全站正文。

  async readBody(id) {
    try {
      const obj = await this.bucket.get(BODY_PREFIX + id + '.json');
      if (!obj) return null;
      const t = await obj.text();
      return t ? JSON.parse(t) : null;
    } catch (e) {
      console.error('body read fail:', id, e && e.message);
      return null;
    }
  }

  async writeBody(id, body) {
    await withLock('body:' + id, async () => {
      await this.bucket.put(BODY_PREFIX + id + '.json', JSON.stringify(body || {}));
    });
  }

  async dropBody(id) {
    await withLock('body:' + id, async () => {
      await this.bucket.delete(BODY_PREFIX + id + '.json');
    });
  }

  // 批量写正文（恢复备份时用）。并发 8 路：快，又不会把平台打限流。
  async writeBodies(entries) {
    const list = entries || [];
    const CONC = 8;
    for (let i = 0; i < list.length; i += CONC) {
      await Promise.all(list.slice(i, i + CONC).map(([id, body]) => this.writeBody(id, body)));
    }
  }
}

export function openDocDb(bucket) {
  return new DocDb(bucket);
}
