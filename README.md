# ☁️ 云尚博客 · EdgeOne Makers 版

一个「打开浏览器就能写、点一下就能发」的个人博客。前台、后台、API、数据、图片存储
全部跑在 **腾讯云 EdgeOne Makers** 上，日常写作、评论审核、图片上传、备份恢复全程在浏览器完成，
不需要服务器、不需要本地工具链。

> **关于本目录**：这是从 Cloudflare 版迁移来的 EdgeOne 版本。客户端界面（后台、编辑器、样式）
> 与业务逻辑保持一致，改动集中在**服务端运行时**与**数据存储**两处。
> 原版的完整功能说明、主题设计指南、文章永久链接规则等，见 [README-cloudflare.md](README-cloudflare.md)。
> ⚠️ 注意：文中「**整站访问量 PV / UV**」相关的章节属于**原版**功能，本版已下线；
> **文章阅读数**本版保留（见下），两边写法有细微差别。

---

## 📦 数据存在哪

**全部数据落在平台自带的 Blob 存储上** —— 不依赖任何第三方数据库，也没有需要单独盯的免费额度。
Blob 是对象存储、没有 SQL 引擎，所以数据层做成「**一份 JSON = 一张表**」，查询在 JS 里做：

| 文档 | 内容 |
|---|---|
| `db/posts.json` | 文章**元数据**（标题、别名、状态、字数、评论数、摘要…）—— 列表页只读它 |
| `db/body/{id}.json` | 文章**正文** —— 只有详情页才读，避免列表页拖走全站正文 |
| `db/settings.json` | 站点设置（`{key: value}`） |
| `db/categories.json` / `db/tags.json` / `db/post_tags.json` | 分类 / 标签 / 两者的关联 |
| `db/comments.json` / `db/links.json` | 评论 / 友情链接 |
| `db/seq.json` | 各表自增游标（Blob 没有 `AUTOINCREMENT`，只能自己记） |
| `media/` `backups/` `themes/` | 图片 / 备份 / 主题（与 `db/` 同库不同前缀，互不干扰） |

**为什么不用 Makers 自带的 KV？** 因为 **KV 只支持边缘函数**，本项目跑在**云函数**上，
够不着；云函数能用的第一方存储只有 Blob。这一点是选型的硬约束，不是偏好问题。

---

## 📊 关于「访问量」与「阅读数」

这两项统计被**区别对待**，不是一刀切：

| 功能 | 本版 | 说明 |
|---|---|---|
| 单篇文章的**阅读数** | ✅ **保留** | 文章维度，写入频率低；`docdb` 的写锁会把同实例内的并发写串行化。跨实例并发仍可能少记一次，个人博客量级下可接受 |
| 全站 **PV / UV**（`/api/hit`、`blog_vid` 访客 Cookie、后台防刷、7 天趋势图） | ❌ 已移除 | 「每次访问 +1」的高频写，Blob 没有原子自增，量越大越不准 —— 留着只会给出误导性的数字，索性连表、接口、看板一并不做 |

阅读数的落点：

- 前台文章详情页显示「N 次阅读」，列表卡片显示「阅读 N」
- **独立页面（`/p/<别名>`）不计数** —— 服务端不给它渲染 `data-slug`，前台也就不会上报；
  接口层同样挡住（`incView` 只认已发布的 `type='post'`），免得有人直接拿页面别名打接口
- 上报走 `POST /api/view`（公开接口）：前端 `fetch` 异步发送，不等结果、失败也不影响阅读
- 后台文章列表有「阅读 / 评论」列
- 仪表盘有「**热门文章 TOP 5**」：按累计阅读量倒序，只取已发布文章（草稿与页面都不进榜）
- 存在 `db/posts.json` 的 `view_count` 字段；导入老备份时**原值保留**，缺字段的才补 0

> ⚠️ 写入方式与 D1 版一样是「读出来 → +1 → 写回去」，卡住的只是**跨实例同时读写**这一个窗口
> （两个访客在毫秒级内打开同一篇文章才会少记一次）。同实例内由 `docdb` 的模块级写锁排队。
> 仪表盘**不做**阅读量的汇总卡片（「累计阅读」那种整站口径不需要），但**保留**热门文章 TOP 5
> —— 它是文章维度的排序，与已下线的 PV 看板不是一回事。

---

## 🔁 与 Cloudflare 版的对应关系

| 能力 | Cloudflare 版 | EdgeOne 版 | 改动量 |
|---|---|---|---|
| 静态托管 | Pages | Makers 静态托管（`outputDirectory: public`） | 无 |
| 服务端 | Pages Functions `functions/[[path]].js` | 云函数 `cloud-functions/`（`index.js` 管根路径 `/`，`[[default]].js` 管其余） | 入口拆分 |
| 数据存储 | D1（SQLite） | **Blob 文档库** `_lib/store/docdb.js` | 新增数据层（`db.js` 对外接口不变） |
| 对象存储 | R2 | Blob 存储 `_lib/store/blob.js` | 新增适配层 |
| 邮件出网 | `cloudflare:sockets` | Node `net` / `tls` `_lib/store/net.js` | 新增适配层 |
| 整站访问量 | PV / UV（`/api/hit`、防刷、趋势图） | **已移除** | 删除 |
| 文章阅读数 | `posts.view_count` + `/api/view` 上报 | **保留**（写入由 SQL 自增改为文档库读改写） | 重写 `incView` |
| 仪表盘热门文章 TOP 5 | 按 `view_count` 倒序取 5 条 | **保留**（同口径；另把「本月新增文章」「总字数」统一成文章口径，不再把页面算进去） | 新增 `topPosts()` |
| 定时备份 | 需自建外部 Cron Worker | `edgeone.json` 的 `schedules` | **内置，更省事** |
| 后台静态资源 | 经 `env.ASSETS` 转发 | 平台「静态优先」，无需转发 | 删除该分支 |

**服务端改动的文件**：

| 文件 | 改了什么 |
|---|---|
| `[[path]].js` → `_lib/entry.js` | 入口适配：换掉 `cloudflare:sockets`、删除 `env.ASSETS` 转发分支、新增定时备份接口、删除 `/api/hit`（整站 PV 下线，`/api/view` 保留）；实现从入口文件挪进辅助模块（见下文「两个入口」） |
| `_lib/store/*` | 新增：`docdb.js` 文档库、`blob.js`（R2→Blob）、`net.js`（sockets→Node）、`index.js` 装配 |
| `_lib/db.js` | 由 60 多条 SQL 改写为文档操作；文章正文拆文件；删除 `recordHit` / `pvSummary`，`incView` 重写为「读最新 → +1 → 写回」（老备份缺 `view_count` 时补 0） |
| `_lib/util.js` | 客户端 IP 优先取 `context.clientIp`；新增 `bgTask()`；**删除防刷模块**（`hitGuard` 等约 85 行 —— 它只服务于已下线的整站 PV） |
| `_lib/site.js`、`_lib/entry.js` | 保留文章阅读数的两个渲染点（列表卡片「阅读 N」、详情页「N 次阅读」），独立页面不显示 |
| `public/js/site.js`、`public/admin/js/*` | 移除整站 PV 上报与仪表盘访问量看板；`/api/view` 上报、后台列表的「阅读 / 评论」列、仪表盘「热门文章 TOP 5」保留 |
| `_lib/mail.js` | 12 处 Cloudflare 语境文案改成 EdgeOne 表述（**SMTP 协议代码一行未动**） |

**内容形态相关改动的文件**：

| 文件 | 改了什么 |
|---|---|
| `_lib/db.js` | `type` / `in_nav` / `parent_id` 的读写与**读取时归一化**、`catFullSlug()`、`treeCategories()`、`navCategories()`、`listPages()`、`count` 含子分类、删父分类时子分类升级、`stats` 拆出 `pages`、`restoreAll` 给老备份补齐新字段 |
| `_lib/util.js` | 保留顶级路径加 `p`（否则 `/p/<别名>` 会被永久链接规则占用）、新增 `catUrl()` 与 `pageUrl()` |
| `_lib/site.js` | 导航按开关渲染 + 二级分类下拉、`renderPage()`、分类面包屑两级、分类总览层级、站点地图收录页面与二级分类 |
| `_lib/entry.js` | `/p/<slug>` 路由、分类层级规范化 301、注入 `_nav_pages` / `_nav_cats`、文章接口支持 `type`、分类接口的上级校验（400）、5 个导航开关 |
| `public/admin/js/*.js`、`app.css` | 导航拆出「页面」、页面列表视图、分类树与分组下拉、导航开关控件 |

**逻辑一字未动的文件**：`md.js`、`hl.js`、`captcha.js`、`admin-shell.js`，以及主题系统与编辑器。

---

## 📊 免费额度

| 组件 | 用途 | 免费额度 |
|---|---|---|
| Makers 静态托管 | 后台页面、前台样式与脚本 | 不限 |
| Cloud Functions | API + 前台实时渲染 | 100 万次调用/月 |
| **Blob 存储** | **全部数据**（`db/`）+ 图片（`media/`）+ 备份 + 主题 | **1 GB** |

个人博客的用量离这些上限都很远：几百篇文章的 JSON 不过几 MB，占大头的是图片。

---

## ⚠️ 四个必须知道的差异

1. **默认域名（项目域名 / 部署域名）有时限，超时一律返回 401** —— 这是平台的合规限制，官方规则分两种：
   - 加速区域为「**中国大陆可用区**」或「**全球可用区（含中国大陆）**」：
     **必须用系统生成的预览链接访问，有效期只有 3 小时，超时即 401**。
     可在控制台「项目概览」右上角点「预览」重新取一个链接。
   - 加速区域为「**全球可用区（不含中国大陆）**」：
     非中国大陆网络可直接访问，**中国大陆网络访问返回 401**。
   → 所以**长期对外必须绑自有域名**，这是硬性要求，不是可选项。
   绑定前若看到 `401 UNAUTHORIZED / Access Restricted or Authentication Expired`，
   **就是这条限制** —— 不是程序故障，也不是登录问题（后台报「请先登录」是被它带偏了）。
   绑自有域名需完成 ICP 备案；选「全球可用区（不含中国大陆）」则不需要备案。
2. **图片单张上限 8MB → 5MB** —— EdgeOne 云函数的请求体硬上限是 6MB，代码里已相应下调。
   实际影响很小：浏览器端上传前会先转 WebP，通常只剩几百 KB。
3. **对象存储 10GB → 1GB** —— Blob 免费额度较小，图片要更勤快地清理。
4. **邮件 25 端口不可用** —— 云平台普遍封禁，请用 465（SSL）或 587（STARTTLS）。
   另外若项目部署在境外区域，163 / QQ 等国内邮箱可能直接拒收，
   在 `edgeone.json` 里把 `cloudFunctions.mainlandRegions` 设为 `["ap-guangzhou"]` 通常即可解决。

---

## 🔧 平台适配要点（排障时优先看这里）

这几条都是逐条对着官方文档核过的，改动时别踩回去：

1. **目录名必须是 `cloud-functions/`** —— 这是平台升级后的现行统一目录名（Node.js / Python / Go 共用）。
   网上不少资料（含官方旧模板仓库、腾讯云旧文档）写的是 `node-functions/`，那是改名前的名字。
   **若部署后 `/api/*` 与首页全部 404，第一件事就查这里。**
2. **入口导出形态是具名的 `export async function onRequest(ctx)`**，对应官方 Handlers 表里的 `onRequest`。
   不要改成 `export default` —— 默认导出会被平台判定为「框架模式」（Express / Koa 那种实例导出），
   语义完全不同。
3. **路由优先级是「静态资源 > 函数」** —— `public/` 下同路径的文件会直接盖住函数。
   所以 `public/` 里**不要**放 `favicon.svg`：站点图标是函数按主题色动态生成的，放了就再也变不了。
4. **函数上下文（EventContext）**：`request` / `params` / `env` / `clientIp` / `server` / `geo` / `uuid`。
   - 取客户端 IP 用 `context.clientIp`（官方字段），不要靠 `x-forwarded-for` 猜。
   - `waitUntil` **只在「边缘函数」的文档里明确列出，云函数那份文档没列** ——
     所以代码里统一走 `_lib/util.js` 的 `bgTask()`：平台有 `waitUntil` 就用，没有就降级成不等待的后台
     Promise，两条路都吞掉 rejection。邮件通知就是走这条，失败绝不影响评论提交。
5. **硬限制**：请求体 **6 MB**（所以图片上限设为 5 MB，留 1 MB 余量）；
   单次执行 **10–120 秒**（本项目配 60 秒）；npm 依赖可正常使用；单文件代码上限 128 MB。
6. **`schedules` 定时任务**：`cron` 必须是 **5 段**（不支持秒级），最小间隔 1 天；
   `path` 填函数路径，`method` 默认 `POST`。**`timezone` 建议显式写**（本项目写 `Asia/Shanghai`），
   否则取构建机器本地时区，触发时间不确定。
7. **Blob 的 `list()` 不返回 `size` / `uploaded`** —— 只给 `{ key, etag }`。
   后台媒体列表的「上传时间」因此只能**从命名规则反推**（备份名 14 位日期、媒体名 13 位 epoch 毫秒，
   两种都要认）。另外 Blob **不支持自定义元数据**，content-type 一律按 key 的扩展名推断。
8. ★ **两个入口，且入口之间绝不能互相 import**（构建会直接失败）。
   - 平台的 catch-all `[[default]].js` 只匹配「**一段或多段**」路径，**不匹配零段** ——
     请求 `/` 根本进不到函数。而首页是 SSR，`public/` 下不可能放 `index.html`，
     于是平台返回它自己的 404：`{"error":"Not Found","message":"The requested path does not exist"}`。
     症状很有迷惑性：**后台、`/categories`、`/api/*`、rss/sitemap 全正常，只有首页 404**，
     很容易误判成「云函数没部署」。
   - 所以另配一个 `cloud-functions/index.js`（官方路由表里明确列了 `index.js` → `example.com/`）。
   - **实现必须放在辅助模块 `_lib/entry.js`**，两个入口各自薄薄一层转发。若写成
     `index.js` 里 `import { onRequest } from './[[default]].js'`，构建会报：

     ```
     ERROR: The symbol "onRequest" has already been declared
       6584 │ const onRequest = onRequest2;
       5326 │ async function onRequest(ctx) {
     ```

     原因：平台把所有入口文件打进**同一个作用域**（产物就是一份
     `.edgeone/cloud-functions/api-node/index.mjs`），入口互相 import 会让两边的同名导出撞名。
     官方约定是「只有导出 Handler 的文件才算入口，其余 `.js` 一律算辅助模块」，
     按这个约定分文件就没事。构建产物里的路由配置可自查：
     `.edgeone/cloud-functions/api-node/config.json` → `[{"src":"^/$"},{"src":"^/(.*)$"}]`。

---

## 🚀 部署（一次性）

**准备**：腾讯云账号、一个域名（见差异 1）。**不需要注册任何数据库**。

### 第 1 步：推到 GitHub

新建 **Private** 私有仓库 → `Add file → Upload files` 把本目录全部内容拖进去 → Commit。
（不需要本地装 Git / Node）

> 上传前可以删掉 `node_modules/`，平台会自己装依赖。

### 第 2 步：EdgeOne 导入

1. 腾讯云控制台 → 边缘安全加速平台 EO → **Makers**（原 Pages）
2. 创建项目 → **从 Git 导入** → 选刚建的仓库
3. 构建配置：**输出目录填 `public`**，构建命令留空
4. 部署

### 第 3 步：配置环境变量

项目 → 设置 → 环境变量：

| 变量名 | 值 | 说明 |
|---|---|---|
| `AUTH_SECRET` | 随机长字符串 | 会话签名密钥，**务必改掉示例值** |
| `BLOB_STORE` | `blog-assets` | 选填，Blob 命名空间名（首次调用自动创建） |
| `CRON_KEY` | 随机字符串 | 选填，给定时备份加一道密钥校验 |

改完环境变量需要重新部署一次才生效。

> **没有建表这一步** —— 文档库按需创建 JSON，安装向导跑完数据就有了。

### 第 4 步：初始化博客

打开 `https://<项目域名>/admin` → 按引导填站点名、副标题、作者与管理员账号 →
提交后自动登录（**仅首次可用**）。站点默认设置（评论开关、每页条数、主题色等）会在这时一并写入。

> ⚠️ **没绑域名时，这一步最容易卡住**：默认域名受平台合规限制，**必须用控制台
> 「项目概览」右上角「预览」生成的链接访问** —— 有效期 3 小时，链接上带
> `eo_token=…&eo_time=…`，**别手动删掉这两个参数**；超时或中国大陆访问会直接返回 401。
> 详见下方「四个必须知道的差异」第 1 条。**稳妥顺序：先绑好自有域名，再走安装向导**，
> 免得填到一半链接过期。

### 第 5 步：绑定域名

项目 → 域名管理 → 添加自定义域名 → 按提示加 CNAME → 等 HTTPS 证书签发。
**面向大陆用户访问的域名须完成 ICP 备案**，否则走不了国内节点。

---

## 🔄 从 Cloudflare 老站迁数据

这套博客自带完整的备份链路，**不需要写导出脚本**：

1. 老站后台 → 「备份与恢复」→ 一键备份 → **下载 JSON 到本地**
2. 新站后台 → 「备份与恢复」→ 从本地上传该 JSON → 恢复
3. 文章、分类、标签、评论、友链会全量回填；
   **管理员账号保留新站自己的**（密码不会跟着迁，这是刻意的安全设计）
4. 老备份里的 **PV 数据会被忽略**（本版没有这张表）；文章**阅读数原样保留**，缺该字段的老文章补 0，都不影响其余数据

**图片要单独搬**（Blob 与 R2 是两套存储）：

1. 老站后台 → 「图片库」逐张下载，或直接访问 `/media/<文件名>` 另存
2. 新站后台 → 「图片库」批量上传

图片不多时手动搬最省事；量大可以让我写个批量搬运脚本。

> 迁完先别急着切域名：用项目默认地址验证一遍，确认无误再改解析。

---

## 📁 工程结构

```
edgeone-blog/
├── edgeone.json              # 平台配置：静态目录、函数时长、缓存规则、定时备份
├── package.json              # 唯一的运行时依赖（Blob SDK）
├── cloud-functions/
│   ├── index.js              # 入口①：站点根 `/`（catch-all 不匹配零段，必须单独配一个）
│   ├── [[default]].js        # 入口②：catch-all，一段或多段路径
│   └── _lib/
│       ├── entry.js          # ★ 两个入口共用的实现：/api/*、前台 SSR、rss/sitemap/robots、/media 代理
│       ├── store/            # 迁移新增的适配层
│       │   ├── docdb.js      #   ★ 数据层：Blob 文档库（一份 JSON = 一张表）
│       │   ├── blob.js       #   R2 风格接口 → EdgeOne Blob
│       │   ├── net.js        #   cloudflare:sockets → Node net / tls
│       │   └── index.js      #   把上面几个装配成 env.DB / env.BLOG
│       ├── db.js  site.js  md.js  hl.js  md5.js
│       └── captcha.js  auth.js  util.js  mail.js  admin-shell.js
├── public/                   # 静态资源：后台单页应用、前台脚本与样式
├── themes-example/           # 示例主题（可直接拖入后台安装）
└── README-cloudflare.md      # 原 Cloudflare 版文档（功能说明 / 主题指南 / FAQ）
```

---

## ❓ 常见问题

**Q：为什么不继续用 Cloudflare？**
EdgeOne 面向大陆访问更稳、控制台与文档是中文，而且省掉了「另建一个 Cron Worker 做定时备份」这一步。

**Q：为什么数据不放在数据库里？**
新平台能稳定使用的第一方存储只有 Blob（KV 只支持边缘函数，这个项目是云函数）。
个人博客的读写量很小，把 JSON 当表用完全够；而且**全部数据都在平台内**，
不用担心第三方服务的免费额度、数据出境或跑路。

**Q：JSON 存数据，会不会有并发写丢数据的问题？**
概率极低但确实存在：文档库内部有一道**模块级写锁**，把同一进程内的并发写排队，
把「读—改—写」的窗口收到最小。真正致命的是「每次访问 +1」那类高频写 ——
所以**整站 PV / UV 被整个删掉了**（见上文），只留下低频的**文章阅读数**
（文章维度、量小，偶发少记一次可接受）。个人博客的写入几乎都来自后台单人操作，
前台写只有评论提交与阅读数上报，冲突基本不会发生。

**Q：免费额度会超吗？**
几百篇文章的 JSON 不过几 MB，占大头的是图片。Blob 免费 1 GB，用满之前你早该清图了。

**Q：怎么自动备份？**
已内置：`edgeone.json` 配了每天 **03:00（北京时间）** 触发 `/api/cron/backup`。
时间在配置里显式写了 `"timezone": "Asia/Shanghai"` —— 不写的话平台会取构建机器的本地时区，
触发时间会变得不确定。
接口带两道防刷（最小间隔 6 小时、只保留最近 20 份），被外部刷也不会失控。

**Q：还能换主题吗？**
能，主题系统完全没动。后台「主题」页拖入主题文件夹即可，主题文件存在 Blob 的 `themes/` 下。

**Q：后台在哪？**
`https://你的域名/admin`。页脚不暴露后台入口（与原版一致）。

---

## 🧪 本地自检（可选）

面向服务端的回归测试，共 **20 个脚本、860 余条断言**，**实测 20 / 20 全通过**。
需要本地有 Node（≥20），且先装一次依赖：

```bash
npm install              # 只有 Blob SDK 一个依赖
node .smoke.mjs          # Markdown 渲染与 XSS 断言
node .theme-smoke.mjs    # 主题系统：变量注入 / 外链 / 编辑预览联动
node .dash-smoke.mjs     # 仪表盘接口语义、鉴权、字段裁剪 + 前端渲染
node .mail-smoke.mjs     # 假 SMTP 服务器的协议级断言 + 路由集成
```

其余同理（`.bkdel-` / `.blink-` / `.catslug-` / `.copyright-` / `.cpui-` / `.email-` /
`.emailui-` / `.imp-` / `.links-` / `.mailcustom-` / `.mailui-` / `.nav-` / `.pages-` /
`.permalink-` / `.pubjump-` / `.rootroute-` / `.subcat-`）。
`.gen-admin-shell.mjs` 是从 `public/admin/index.html` 重新生成 `_lib/admin-shell.js` 的工具。

**几点说明**：

- 测试注入 `env.BLOG` 为**内存 Blob 桩**（`.blobstub.mjs`），在其上跑**真实路由**，
  业务逻辑覆盖得很实，但**不覆盖** Blob / net 两个适配层与真实服务之间的交互 —— 那部分只能靠部署后实测。
- `.socket-stub.mjs` 会把出网实现换成「一调用就抛错」的桩，保证测试不去连真实 SMTP 服务器、
  也不依赖外网。测试注入的是假 socket，协议级断言照样做。
- 不装 Node 完全不影响部署，这些纯粹是开发期自检。
- ★ **构建层面的自检（强烈推荐）**：装上平台 CLI 后跑 `edgeone makers build`，
  它会完整走一遍平台自己的构建链路，包括最容易出事的「Node functions build」那一步。
  **过不了这一步，推到 GitHub 就一定构建失败** —— 而本地那批 `.*-smoke.mjs` 是测不出这类问题的
  （2026-09-18 就是这么栽的：本地全绿、线上构建直接失败）。
  构建产物落在 `.edgeone/`（已在 `.gitignore` 里），其中
  `.edgeone/cloud-functions/api-node/config.json` 就是平台生成的路由表，
  可以顺手核对根路径有没有被注册、catch-all 有没有在。

---

## 📚 功能说明

前台 / 后台的全部功能、主题设计指南、文章永久链接规则、评论与备份细节，
见 [README-cloudflare.md](README-cloudflare.md)（其中**整站访问量 PV / UV** 相关章节在本版已不适用；文章阅读数本版保留）。
