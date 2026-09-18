// ============================================================
// catch-all 入口：cloud-functions/[[default]].js
// 匹配「一段或多段」路径（官方文档：[[param]] 匹配一个或多个路径段）——
// ★ 注意它**不匹配零段**，所以站点根 `/` 必须另配 cloud-functions/index.js。
// 实现见 _lib/entry.js，这里只做转发。
// ============================================================
import { handleRequest } from './_lib/entry.js';

export async function onRequest(ctx) {
  return handleRequest(ctx);
}
