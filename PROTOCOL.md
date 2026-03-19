# Steam 加速代理服务协议文档

## 概述

本文档描述了 Steam 加速代理服务所使用的身份验证协议。该服务充当 Steam 社区和商店 API 的反向代理，采用严格的访问控制措施防止滥用。

## 允许的端点

| 代理路径 | 目标 |
|---------|------|
| `/id/*` | `https://steamcommunity.com/id/*` |
| `/profiles/*` | `https://steamcommunity.com/profiles/*` |
| `/api/*` | `https://store.steampowered.com/api/*` |

所有其他路径将返回 HTTP 500，响应体为空。

## 身份验证

### User-Agent 格式

所有请求必须在 `User-Agent` 请求头中包含 `SteamSpeedService` 令牌：

```
User-Agent: SteamSpeedService/<encrypted_token>
```

令牌可以放在 User-Agent 字符串中的任何位置，允许您在前面或后面添加其他信息。

### 令牌结构

令牌是加密数据，其明文格式如下：

```
<client_ip>:<timestamp>:<request_id>
```

| 字段 | 说明 |
|------|------|
| `client_ip` | 客户端 IP 地址（可简化为 `0.0.0.0`） |
| `timestamp` | UTC 时间戳，单位为毫秒（Unix 纪元） |
| `request_id` | 唯一的请求标识符 |

**示例明文令牌：**
```
0.0.0.0:1710864000000:m5k8j3f-a1b2c3d4e5f6g7h8
```

### 时间戳验证

- 必须为自 Unix 纪元以来的 UTC 时间，单位为毫秒
- 必须在服务器时间的**±10 秒**范围内
- 过期或未来的令牌将被拒绝

### 请求 ID 格式

请求 ID 必须对每个请求唯一。推荐格式：

```
<base36_timestamp>-<random_hex>
```

**TypeScript 实现：**
```typescript
function generateRequestId(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(8).toString('hex');
  return `${timestamp}-${random}`;
}
```

**示例输出：** `m5k8j3f-a1b2c3d4e5f6g7h8`

### 防重放保护

- 每个请求 ID 只能使用**一次**
- 服务器维护 30 秒的滑动窗口来追踪已使用的 ID
- 重放请求将被拒绝，返回 HTTP 500

## 加密

### 算法：AES-256-GCM

| 参数 | 值 |
|------|-----|
| 算法 | AES-GCM |
| 密钥大小 | 256 位（32 字节，64 个十六进制字符） |
| IV 大小 | 96 位（12 字节） |
| 认证标签大小 | 128 位（16 字节） |

### 加密令牌格式

```
URL-safe-Base64(IV + Ciphertext + AuthTag)
```

- **IV**：12 个随机字节
- **Ciphertext**：加密的令牌明文
- **AuthTag**：16 字节的 GCM 认证标签
- **编码**：URL-safe Base64（无填充，`-` 代替 `+`，`_` 代替 `/`）

### TypeScript 加密实现 (Node.js)

```typescript
import * as crypto from 'crypto';

const IV_LENGTH = 12;

function encrypt(plaintext: string, hexKey: string): string {
  const key = Buffer.from(hexKey, 'hex');
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // 组合：iv + ciphertext + authTag
  const combined = Buffer.concat([iv, encrypted, authTag]);

  // 转换为 URL-safe base64
  return combined
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}
```

### TypeScript 解密实现 (Web Crypto API)

```typescript
const IV_LENGTH = 12;

async function decrypt(encryptedBase64: string, hexKey: string): Promise<string | null> {
  try {
    // 恢复标准 base64
    let base64 = encryptedBase64.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';

    // 解码
    const combined = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const iv = combined.slice(0, IV_LENGTH);
    const ciphertext = combined.slice(IV_LENGTH);

    // 导入密钥
    const keyBytes = new Uint8Array(hexKey.match(/.{2}/g)!.map(b => parseInt(b, 16)));
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);

    // 解密
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}
```

## 完整请求示例

### 步骤 1：生成令牌组件

```typescript
const clientIp = '0.0.0.0';
const timestamp = Date.now();  // e.g., 1710864000000
const requestId = generateRequestId();  // e.g., "m5k8j3f-a1b2c3d4e5f6g7h8"
```

### 步骤 2：构建明文令牌

```typescript
const token = `${clientIp}:${timestamp}:${requestId}`;
// 结果："0.0.0.0:1710864000000:m5k8j3f-a1b2c3d4e5f6g7h8"
```

### 步骤 3：加密令牌

```typescript
const secretKey = '<your-64-char-hex-key>';  // 用您的密钥替换
const encryptedToken = encrypt(token, secretKey);
// 结果：URL-safe base64 字符串
```

### 步骤 4：构建 User-Agent

```typescript
const userAgent = `SteamSpeedService/${encryptedToken}`;
```

### 步骤 5：发送请求

```typescript
const response = await fetch('https://<your-domain>/profiles/<steamid>', {
  headers: {
    'User-Agent': userAgent,
  },
});
```

## 错误处理

为了防止信息泄露，所有错误都返回相同的响应：

| 错误情况 | 响应 |
|---------|------|
| 无效路径 | HTTP 500，响应体为空 |
| 缺少令牌 | HTTP 500，响应体为空 |
| 解密失败 | HTTP 500，响应体为空 |
| 无效时间戳 | HTTP 500，响应体为空 |
| 重放攻击 | HTTP 500，响应体为空 |
| 上游错误 | HTTP 500，响应体为空 |

## 安全考虑事项

1. **密钥保护**：永远不要在客户端代码或公开仓库中暴露密钥
2. **仅 HTTPS**：所有请求都必须使用 HTTPS
3. **时钟同步**：确保客户端时钟已同步（通过 NTP）以通过时间戳验证
4. **请求 ID 唯一性**：始终为每个请求生成新的请求 ID
5. **令牌新鲜度**：在发送请求之前立即生成令牌

## 配置

### 密钥生成

- 必须是 64 个十六进制字符（256 位）
- 对于 Cloudflare Workers，存储在环境变量 `SECRET_KEY`
- 对于本地客户端，存储在 `config.json`（添加到 `.gitignore`）

**生成安全密钥：**

```bash
# 使用 OpenSSL
openssl rand -hex 32

# 使用 Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
