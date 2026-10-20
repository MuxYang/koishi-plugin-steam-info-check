# Steam Speed Worker

基于维护者提供的线上 Workers 代码整理，使用 MIT 许可证。兼容插件现有 `SteamSpeedService/<AES-256-GCM token>` 协议，不需要修改插件。

## 本地检查与部署

需要 Node.js 22 或更新版本和一个 Cloudflare 账号：

```bash
npm ci
npm run check
npm test
npm run types
npm run build                 # 仅检查打包，不部署
```

`wrangler.jsonc` 使用名为 `CACHE` 的 KV binding。首次部署时 Wrangler 会提示创建 KV；迁移已有 Worker 时，在 `kv_namespaces` 中填写原 `CACHE` 命名空间的 `id`，避免使用新的空缓存。按需修改 Worker 名称和自定义域名，不要将账号信息或部署密钥提交到 Git。

生成 32 字节随机密钥，然后通过交互式提示写入：

```bash
openssl rand -hex 32
npx wrangler secret put SECRET_KEY
npm run deploy
```

将输出的 HTTPS 域名和相同密钥填入插件 `steamSpeedDomain`、`steamSpeedKey`。域名不带末尾 `/`。本地调试可复制 `.dev.vars.example` 为 `.dev.vars` 并替换密钥，然后运行 `npm run dev`；此文件已忽略。

## 路由与缓存

| 路径 | 行为 |
| --- | --- |
| `/id/*`、`/profiles/*` | 带令牌代理 Steam 社区 |
| `/api/*` | 带令牌代理 Steam 商店 API |
| `/avatar/*` | 保留原版的带令牌头像代理 |
| `/res/<64位小写SHA-256>` | 无需令牌，仅读取已经缓存的内容寻址资源 |

支持 `GET`、`HEAD` 和 CORS `OPTIONS`；非法路径、鉴权失败、资源未命中和上游失败返回空的 `500` 响应。不会把插件令牌或 Cookie 转发给 Steam。

保留线上版的正文及头像缓存策略：KV 保存 30 天，每 24 小时重新校验内容，上游失败时允许返回旧缓存。插件的好友实时状态仍直接通过 Steam Web API 获取；如需即时刷新 `steam.info` 页面，请清理对应 KV 的 `cache:<路径及查询参数>` 键。

## 资源链接替换

- HTML 中的图片、样式、脚本直链及内嵌 JS/JSON 的 `https:\/\/...` 转义 URL 会替换为 `https://<当前Worker域名>/res/<hash>` 绝对地址，支持插件使用 `about:blank` 渲染。
- 只预取 HTTPS 的 `*.steamstatic.com` 和 `steamcdn-a.akamaihd.net`，拒绝任意站点和资源跳转。CDN 配置用的目录根地址保持原样。
- CSS 中的相对图片/字体地址也会处理；超出一层的导入样式保留上游地址。失败的 HTML 资源保持原地址，失败的 CSS 相对资源转换为上游绝对地址。
- 每个页面最多预取 24 个资源（包括 CSS 子资源），最多 4 路并行；单资源最多 4 MiB，正文最多 2 MiB。资源索引缓存一天，内容缓存 30 天；命中的内容地址响应带 `immutable`。
- 资源使用 KV 存储，没有 C++ 版的 512 MiB 进程内 LRU 上限；KV 用量和请求次数计入你的 Cloudflare 配额。KV 跨区域同步不是即时的，刚生成的资源在另一地区可能短暂未命中。

令牌时间戳允许 ±10 秒误差，防重放记录保留 30 秒。保留原版的 isolate 内防重放实现；多个边缘 isolate 之间不提供全局唯一性保证。

协议格式见 [PROTOCOL.md](./PROTOCOL.md)，VPS 版本见 [C++ 分支](https://github.com/MuxYang/koishi-plugin-steam-info-check/tree/steam-speed-cpp)。
