// ============================================================
// 根路径入口：cloud-functions/index.js → 站点根 `/`
//
// 为什么非要有它：平台的 catch-all `[[default]].js` 只匹配「一段或多段」路径，
// **不匹配零段**。也就是说请求 `/` 时根本进不到云函数；而 public/ 下没有
// index.html（首页是 SSR，不可能放静态文件），于是平台直接返回它自己的 404：
//   {"error":"Not Found","message":"The requested path does not exist"}
// 表现就是「后台正常、/categories 正常、rss 正常，唯独首页 404」。
//
// 官方路由表里明确列了 /cloud-functions/index.js → example.com/，这是正规做法。
// 路由优先级「静态 > 单级动态 > 多级动态(Catch-all)」：index.js 属静态路由，
// 优先级高于 catch-all。首页渲染就在分发器的 front() 里（seg.length === 0 分支）。
//
// ★ 这里**绝不能**写成 `import { onRequest } from './[[default]].js'`：
//   两个入口文件的同名导出会被构建器并进同一作用域，构建报
//   `The symbol "onRequest" has already been declared`（2026-09-18 实测）。
//   所以真正的实现放在辅助模块 _lib/entry.js，两个入口各自薄薄一层转发。
// ============================================================
import { handleRequest } from './_lib/entry.js';

export async function onRequest(ctx) {
  return handleRequest(ctx);
}
