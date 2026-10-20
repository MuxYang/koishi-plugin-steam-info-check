# koishi-plugin-steam-info-check

[![npm](https://img.shields.io/npm/v/koishi-plugin-steam-info-check?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-steam-info-check)

Steam 好友状态播报 koishi 插件 (基于nonebot版本修改，https://github.com/zhaomaoniu/nonebot-plugin-steam-info ）

## 非 Steam 游戏

支持显示通过 Steam「添加非 Steam 游戏」启动的程序（例如 FL Studio）。好友状态列表和开始游戏播报会标注「非 Steam 游戏」，保留自定义名称，不查询 Steam 商店翻译；`steam.info` 也会显示社区资料页上的当前运行状态。

无需额外配置。好友列表和自动播报以 Steam API 返回的活动为准，资料卡以社区公开页面为准；隐私设置或上游未返回的活动无法显示。非 Steam 游戏不会生成 Steam 游戏时数或成就记录。

## 重复播报过滤

每个用户在各群分别记录上一次播报的游戏；再次开始同一游戏时不重复播报，离线、短暂退出或经过较长时间都不会清空记录。播报过其他游戏后，可以再次播报原来的游戏。此机制同时适用于 Steam 和非 Steam 游戏，不影响手动查询。

记录保存在内存中，重载插件或重启后重新建立；连续七天未在接口结果中出现的用户会随过期状态缓存一起清理。

## Steam 加速计划

本插件支持使用自建的加速代理服务加速 Steam 社区和 API 请求。详见 [PROTOCOL.md](./PROTOCOL.md)。

代理服务源码在独立分支维护，不包含在插件 npm 包中：

- [C++ / Linux VPS 代理](https://github.com/MuxYang/koishi-plugin-steam-info-check/tree/steam-speed-cpp)：systemd 部署，可由 ESA 等边缘服务终止 HTTPS。
- [Cloudflare Workers 代理](https://github.com/MuxYang/koishi-plugin-steam-info-check/tree/steam-speed-worker)：边缘部署，保留页面资源链接替换。

### 配置

需要两个参数：

- **加速服务域名**：Cloudflare Worker、ESA 回源域名或其他反向代理服务的域名，例如 `https://steam.example.com`
- **加速服务密钥**：64位十六进制字符串，由部署者生成并保存

### User-Agent 格式

所有通过加速服务的请求 User-Agent 头格式如下：

```
SteamSpeedService/<encrypted_token>
```

其中 `<encrypted_token>` 是加密后的令牌，包含客户端 IP、时间戳和请求 ID。

### 加密格式

令牌加密使用 AES-256-GCM 算法，采用以下格式：

```
URL-safe-Base64(IV + Ciphertext + AuthTag)
```

参数说明：
- **IV**：12个随机字节
- **Ciphertext**：使用 AES-256-GCM 加密的令牌明文
- **AuthTag**：16字节 GCM 认证标签
- **编码**：URL-safe Base64（`-` 代替 `+`，`_` 代替 `/`，无填充）

令牌明文格式：

```
<client_ip>:<timestamp>:<request_id>
```

例如：`0.0.0.0:1710864000000:m5k8j3f-a1b2c3d4e5f6g7h8`

### 需要代理的页面

当启用加速计划时，以下请求会通过加速服务：

| 请求类型 | 说明 |
|---------|------|
| `/id/<steamid>/` | Steam 社区个人资料页面 |
| `/profiles/<steamid>` | Steam 社区个人资料页面 |
| `/api/appdetails` | Steam 商店 API 游戏详情接口 |

**安全提示**：

- 不要对所有 Steam 请求进行代理，以防止服务被判定为恶意网站
- UA 中包含的请求 ID 必须唯一，防止重放攻击
- 加速服务密钥不要泄露到公开仓库或插件配置中
- 使用 HTTPS 访问加速服务

## 故障排查

遇到连接问题？查看 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) 了解常见错误和解决方案。

主要错误：
- `无法连接到 Steam 社区或加载超时` - [查看排查步骤](./TROUBLESHOOTING.md#错误1-无法连接到-steam-社区或加载超时)
- `Cannot navigate to invalid URL` - [查看排查步骤](./TROUBLESHOOTING.md#错误2-cannot-navigate-to-invalid-url)
- `无法获取 Steam 资料，账户不存在或为私密` - [查看排查步骤](./TROUBLESHOOTING.md#错误3-无法获取-steam-资料账户不存在或为私密)
