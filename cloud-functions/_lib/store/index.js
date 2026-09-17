// ============================================================
// 环境装配：把 EdgeOne 的环境变量 + 各适配层，组装成原代码认识的 env
//
// 原代码里到处是 env.DB（D1）与 env.BLOG（R2）。本文件在入口处把它们替换成
// Blob 上的等价实现，业务代码因此一行都不用改：
//   env.BLOG → Blob 存储（R2 风格接口，见 blob.js）
//   env.DB   → Blob 文档库（见 docdb.js）
//
// 平台选型说明：Makers 自带的 KV 只支持 Edge Functions，本项目跑在
// Cloud Functions 上，能用的第一方存储只有 Blob，所以 DB 层也落在 Blob 上。
//
// 用 Object.create(src) 而不是展开拷贝：这样 env.AUTH_SECRET 这类配置项
// 仍能沿原型链读到，不必猜测 EdgeOne 传进来的对象里到底有什么。
// 赋值只落在新对象自身，不会污染平台传入的 env。
// ============================================================
import { openR2 } from './blob.js';
import { openDocDb } from './docdb.js';

let cacheKey = '';
let cacheBucket = null;

export function resolveEnv(rawEnv) {
  const src = rawEnv || {};

  // ★ 已注入的绑定优先。env.DB / env.BLOG 若已经存在（测试用的内存桩、
  //   将来换数据层实现），这里一律不覆盖 —— 装配层只负责「补空缺」，不负责「夺权」。
  if (src.DB && src.BLOG) return src;

  // 缓存键带 BLOB_STORE：换过 store 名时不能继续用旧句柄
  const key = src.BLOB_STORE || '';
  if (!src.BLOG && (!cacheBucket || key !== cacheKey)) {
    cacheBucket = openR2(src.BLOB_STORE || 'blog-assets');
    cacheKey = key;
  }

  const env = Object.create(src);
  // 赋值只落在新对象自身，不污染平台传入的 env
  if (!src.BLOG) env.BLOG = cacheBucket;
  // ★ DocDb 必须「每请求新建」：它带着请求级的读缓存，跨请求复用会把上一个
  //   请求的数据带给下一个请求。底层 Bucket 才是无状态可复用的句柄，所以
  //   缓存 Bucket、不缓存 DocDb。
  if (!src.DB) env.DB = openDocDb(env.BLOG);
  return env;
}
