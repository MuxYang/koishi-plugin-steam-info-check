# Steam Speed Service (C++ / ESA origin)

这是 [Steam 加速计划](./PROTOCOL.md) 的服务端参考实现，面向“国外 VPS + ESA 负责 HTTPS 证书”的部署方式。

```text
Koishi 插件 --HTTPS--> ESA 边缘节点 --HTTP--> 本服务 :8467 --> Steam (HTTPS)
```

本服务校验 AES-256-GCM 令牌、防重放、按白名单回源、限制请求频率，并为 Steam 页面静态资源提供有界内存缓存。它不处理证书，也不依赖 Node.js、Caddy、Nginx、Redis 或数据库。运行时是一个动态链接 OpenSSL 的小型 C++ 进程。

## 服务器要求

- Linux x86_64 或 arm64，systemd
- 能访问 `steamcommunity.com` 和 `store.steampowered.com` 的 443 端口
- 一个已在 ESA 接入的域名（插件侧使用 `https://`）
- 本地构建需要 `g++`/`clang++`、`pkg-config` 和 OpenSSL 开发头文件；VPS 运行时只需 OpenSSL 运行库

## 本地构建并上传

在本机 Linux、macOS 或 WSL 中安装 `g++`、`pkg-config` 和 OpenSSL 开发包，然后在项目目录构建。构建产物是按 CPU 架构命名的压缩包，服务器不需要编译器、源码或开发头文件。

```bash
bash build-local.sh
scp dist/steam-speed-linux-x86_64.tar.gz root@your-server:/root/
ssh root@your-server
mkdir -p /root/steam-speed-release
tar -xzf /root/steam-speed-linux-x86_64.tar.gz -C /root/steam-speed-release
cd /root/steam-speed-release/steam-speed
sudo bash install.sh --domain steam.example.com
```

在与目标服务器架构一致的 Linux 环境中构建，例如 Linux 主机、WSL 或容器。脚本不会把编译任务转交给 VPS。

`--domain` 填 ESA 上配置的加速域名，只用于生成控制台提示和回源跳转地址，不会去申请证书。也可以省略，脚本会提示输入；仍然留空时，部署完成后手动把域名填进插件配置即可。

可用参数：

| 参数 | 说明 |
|---|---|
| `--domain HOST` | ESA 加速域名，例如 `steam.example.com` |
| `--port PORT` | 本服务监听端口，默认 `8467` |
| `--bind ADDRESS` | 监听地址，默认 `0.0.0.0`；只允许内网/本机回源时可用 `127.0.0.1`，IPv6 双栈用 `::` |
| `--key HEX` | 使用已有的 64 位十六进制密钥 |
| `--rotate-key` | 生成新密钥并重启服务 |

VPS 安装脚本只运行随包上传的 `steam-speed` 二进制及自检，创建 `steam-speed` 系统用户、写入 systemd 单元并启动服务。不会下载源码或安装编译工具。成功后会打印：

```text
回源监听:       0.0.0.0:8467
回源地址:       http://203.0.113.10:8467
ESA 加速域名:   https://steam.example.com
加速服务密钥:   ........................................
```

同一份配置会保存到 `/root/steam-speed-client.txt`（权限 600）。把其中的域名和密钥填到 Koishi 插件：

```yaml
enableSteamSpeed: true
steamSpeedDomain: https://steam.example.com
steamSpeedKey: <64 位十六进制密钥>
```

`steamSpeedDomain` 不要以 `/` 结尾；插件会直接拼接 `/profiles/...` 和 `/api/...`。

重新运行安装脚本时会保留已有密钥；只有显式使用 `--rotate-key` 才会换新密钥。换密钥后必须同步修改插件配置。

安装脚本会复制到 `/opt/steam-speed/install.sh`，之后可以直接用它重新部署或轮换密钥。

## ESA 配置要点

1. **源站**：协议选 HTTP，地址填服务器公网 IP，端口填脚本输出的端口（默认 `8467`）。
2. **Host**：回源时保留原始 Host，或让 ESA 发送 `X-Forwarded-Host: steam.example.com`。服务用这个值重写 Steam 的跳转地址。
3. **User-Agent**：必须原样透传到源站。插件把加密令牌放在 `User-Agent: SteamSpeedService/...` 中；如果 ESA 改写或清空 UA，所有请求都会返回 500。
4. **缓存**：对 `/profiles/*`、`/id/*`、`/api/*` 关闭 ESA 缓存，避免资料和状态过期；`/res/*` 是 SHA-256 内容地址，可由 ESA 长期缓存。源站会先完整读取 HTML，抓取 `*.steamstatic.com` 静态资源并把链接改写为 `https://<加速域名>/res/<SHA-256>` 绝对 URL，供插件用 `about:blank` 渲染时加载。
5. **回源超时**：建议不低于 30 秒。服务自身对 Steam 的上游超时是 20 秒。
6. **安全组**：放行 TCP `8467`（或你改的端口）。如果 ESA 提供固定的回源 IP 段，建议安全组只允许这些 IP；否则该端口对公网开放，但请求仍需通过 AES-GCM 令牌校验。
7. **证书**：由 ESA 管理，源站不需要 443 证书。
8. **WAF/ bot 规则**：如果启用了 UA 黑名单、Bot 管理或人机挑战，请放行 `SteamSpeedService/*` 和 `/profiles/*`、`/id/*`、`/api/*`、`/res/*`，否则插件或页面静态资源会被边缘拦截。
9. **路径**：ESA 域名应直接回源到服务根路径，不要在域名后配置路径前缀；插件会直接拼接 `/profiles/...` 和 `/api/...`。

## 运行与维护

```bash
systemctl status steam-speed
journalctl -u steam-speed -f
systemctl restart steam-speed
```

内置自检：

```bash
/opt/steam-speed/bin/steam-speed --self-test
```

在本地诊断插件到服务的请求时，可运行 `node diagnose.cjs`。脚本会提示输入域名、测试路径和插件密钥，密钥输入不回显、不写文件，并显示 DNS、TCP、TLS、首字节、HTTP 状态和耗时。遇到服务统一返回的 500 时，需同时查看服务器 `journalctl -u steam-speed -f` 才能辨别鉴权、路径和上游错误。

卸载：

```bash
bash /opt/steam-speed/uninstall.sh
```

## 资源占用

- 单个 C++ 进程，无 Node/V8、无 Caddy、无 Python
- 二进制通常只有几百 KB（动态链接系统 OpenSSL）
- 空闲时常驻 RSS 通常只有几 MB；静态资源缓存按需增长，最多 512 MiB，重启后清空
- 另有内存中的 30 秒防重放表和 60 秒限速表，不写缓存或业务数据到磁盘；每个活动连接一个线程，默认最多 128 个连接
- 编译器和 OpenSSL 头文件只在本地构建阶段使用；VPS 只安装二进制和 systemd 单元

## 协议与安全行为

- 仅接受 `GET` 和 `HEAD`
- 只代理以下路径：
  - `/id/*`、`/profiles/*` -> `https://steamcommunity.com`
  - `/api/*` -> `https://store.steampowered.com`
- 其他路径、缺少令牌、解密失败、时间戳超出 ±10 秒、重放、上游失败，统一返回 `500` 和空响应体
- 令牌：`AES-256-GCM(IV + Ciphertext + AuthTag)`，URL-safe Base64，无填充
- 请求 ID 在 30 秒窗口内只能使用一次
- 默认每 IP 每分钟 240 次、全局每分钟 2400 次；可用环境变量调整
- Steam 页面中的 `*.steamstatic.com` 资源会在返回 HTML 前并行抓取、按内容计算 SHA-256 并缓存；缓存是按需增长的 LRU，最多占用 512 MiB 内存，每页最多预取 256 个、单个文件上限 16 MiB
- `/res/<64位小写SHA-256>` 不需要令牌，只能读取已缓存的内容寻址资源；未命中、非法哈希和普通鉴权失败均返回空的 `500` 响应，不会作为开放代理回源
- HTML 和 CSS 中成功预取的静态资源链接（包括 JavaScript/JSON 字符串中的转义 URL），会重写为 `https://<加速域名>/res/<SHA-256>`；预取失败的链接保留原地址
- 不记录 `User-Agent`，因此不会把令牌写进日志
- 上游请求固定使用 `steamcommunity.com` / `store.steampowered.com`，不会把令牌或 Cookie 转发给 Steam

可调整的环境变量在 `/etc/steam-speed/steam-speed.env`：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `SECRET_KEY` | 安装时生成 | 64 位十六进制密钥 |
| `BIND_HOST` | `0.0.0.0` | 监听地址 |
| `PORT` | `8467` | 监听端口 |
| `PUBLIC_SCHEME` | `https` | 重写跳转地址时使用的协议 |
| `PUBLIC_HOST` | ESA 域名 | 重写跳转地址时使用的主机名 |
| `TRUST_PROXY` | `1` | 是否信任 `X-Forwarded-For` 和 `X-Forwarded-Host` |
| `UPSTREAM_TIMEOUT_MS` | `20000` | 上游 Steam 超时 |
| `LOG_REQUESTS` | `1` | 是否记录每次请求的状态和耗时 |
| `MAX_CONNECTIONS` | `128` | 最大活动连接数 |
| `RATE_LIMIT_PER_MINUTE` | `240` | 单 IP 每分钟上限 |
| `RATE_LIMIT_GLOBAL_PER_MINUTE` | `2400` | 全局每分钟上限 |

## 常见问题

**所有请求都是 500**

先看日志：

```bash
journalctl -u steam-speed -n 50 --no-pager
```

`auth rejected ... missing token` 表示 ESA 没有把插件的 `User-Agent` 透传到源站；`token authentication failed` 表示源站和插件的 `steamSpeedKey` 不一致；`timestamp outside allowed window` 表示服务器时钟偏差超过 10 秒，执行 `timedatectl set-ntp true` 并确认时间同步。

**ESA 返回 502/504**

检查源站 IP、端口和安全组；在服务器上执行：

```bash
curl -i http://127.0.0.1:8467/
```

返回 `500` 且空响应体说明服务本身在正常工作（这是协议规定的未授权响应）。

**`upstream open failed`**

服务器无法访问 Steam。检查出站 443：

```bash
curl -I https://steamcommunity.com/
```

**更换了密钥**

```bash
sudo bash /opt/steam-speed/install.sh --domain steam.example.com --rotate-key
```

然后立即更新 Koishi 插件配置并重载插件。
