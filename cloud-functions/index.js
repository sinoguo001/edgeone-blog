// ============================================================
// 根路径入口：cloud-functions/index.js → 站点根 `/`
//
// 为什么非要有它：平台的 catch-all `[[default]].js` 只匹配「一段或多段」路径，
// **不匹配零段**。也就是说请求 `/` 时根本进不到云函数；而 public/ 下没有
// index.html（首页是 SSR，不可能放静态文件），于是平台直接返回它自己的 404：
//   {"error":"Not Found","message":"The requested path does not exist"}
// 表现就是「后台正常、/categories 正常、rss 正常，唯独首页 404」。
//
// 首页渲染逻辑本来就写在 `[[default]].js` 的 front() 里（seg.length === 0 分支），
// 这里原样转发即可，不重复实现 —— 否则两处逻辑会各改各的。
//
// 路由优先级「静态 > 单级动态 > 多级动态」：index.js 属于静态路由，
// 优先级高于 catch-all，即使将来平台让 catch-all 也能匹配 `/`，走的仍是这里。
// ============================================================
import { onRequest as handleAll } from './[[default]].js';

export async function onRequest(ctx) {
  return handleAll(ctx);
}
