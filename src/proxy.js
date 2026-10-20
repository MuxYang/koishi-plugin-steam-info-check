// Restored from the deployed Worker supplied by the maintainer.
import { readLimited } from './assets.js';


// src/crypto.ts
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
async function importKey(hexKey) {
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) throw new Error("Invalid key");
  const keyBytes = hexToBytes(hexKey);
  if (keyBytes.length !== 32) {
    throw new Error("Key must be 32 bytes (64 hex characters)");
  }
  return crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}
async function decrypt(encryptedBase64, hexKey) {
  try {
    const key = await importKey(hexKey);
    const combined = base64ToBytes(encryptedBase64);
    if (combined.length < IV_LENGTH + TAG_LENGTH) {
      return null;
    }
    const iv = combined.slice(0, IV_LENGTH);
    const ciphertext = combined.slice(IV_LENGTH);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}
function base64ToBytes(base64) {
  let standardBase64 = base64.replace(/-/g, "+").replace(/_/g, "/");
  while (standardBase64.length % 4) {
    standardBase64 += "=";
  }
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(standardBase64, "base64"));
  }
  const binary = atob(standardBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// src/replay-guard.ts
const WINDOW_MS = 30 * 1e3;
const usedRequestIds = new Map();
let lastCleanup = 0;
function cleanup() {
  const now = Date.now();
  if (now - lastCleanup < 5e3) {
    return;
  }
  lastCleanup = now;
  const cutoff = now - WINDOW_MS;
  for (const [id, timestamp] of usedRequestIds) {
    if (timestamp < cutoff) {
      usedRequestIds.delete(id);
    }
  }
}
function checkAndMarkRequestId(requestId) {
  cleanup();
  if (usedRequestIds.has(requestId)) {
    return false;
  }
  usedRequestIds.set(requestId, Date.now());
  return true;
}

// src/validator.ts
const TIMESTAMP_TOLERANCE_MS = 10 * 1e3;
const TOKEN_PREFIX = "SteamSpeedService/";
function extractToken(userAgent) {
  if (!userAgent)
    return null;
  const index = userAgent.indexOf(TOKEN_PREFIX);
  if (index === -1)
    return null;
  const start = index + TOKEN_PREFIX.length;
  const end = userAgent.indexOf(" ", start);
  return end === -1 ? userAgent.slice(start) : userAgent.slice(start, end);
}
function parseToken(decrypted) {
  const parts = decrypted.split(":");
  if (parts.length < 3)
    return null;
  const ip = parts[0];
  const timestamp = /^\d+$/.test(parts[1]) ? Number(parts[1]) : NaN;
  const requestId = parts.slice(2).join(":");
  if (!ip || !Number.isSafeInteger(timestamp) || !requestId || requestId.length > 128) {
    return null;
  }
  return { ip, timestamp, requestId };
}
async function validateRequest(request, secretKey) {
  const userAgent = request.headers.get("User-Agent");
  const encryptedToken = extractToken(userAgent);
  if (!encryptedToken) {
    return { valid: false };
  }
  const decrypted = await decrypt(encryptedToken, secretKey);
  if (!decrypted) {
    return { valid: false };
  }
  const parsed = parseToken(decrypted);
  if (!parsed) {
    return { valid: false };
  }
  const now = Date.now();
  const tokenTime = parsed.timestamp;
  const timeDiff = Math.abs(now - tokenTime);
  if (timeDiff > TIMESTAMP_TOLERANCE_MS) {
    return { valid: false };
  }
  if (!checkAndMarkRequestId(parsed.requestId)) {
    return { valid: false };
  }
  return {
    valid: true,
    clientIp: parsed.ip,
    timestamp: parsed.timestamp,
    requestId: parsed.requestId
  };
}
function isPathAllowed(pathname) {
  return pathname.startsWith("/id/") || pathname.startsWith("/profiles/") || pathname.startsWith("/api/") || pathname.startsWith("/avatar/");
}

// src/cache.ts
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const REVALIDATE_INTERVAL_MS = 24 * 60 * 60 * 1e3;
function buildCacheKey(pathname, search) {
  return `cache:${pathname}${search}`;
}
async function computeHash(text) {
  const data = new TextEncoder().encode(text);
  return computeHashBytes(data);
}
async function computeHashBytes(data) {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = new Uint8Array(hashBuffer);
  let hex = "";
  for (const b of hashArray) {
    hex += b.toString(16).padStart(2, "0");
  }
  return hex;
}
function shouldRevalidate(checkedAt) {
  return Date.now() - checkedAt > REVALIDATE_INTERVAL_MS;
}
async function getCachedEntry(key, kv) {
  const raw = await kv.get(key, "text");
  if (!raw)
    return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
async function setCachedEntry(key, entry, kv) {
  await kv.put(key, JSON.stringify(entry), {
    expirationTtl: CACHE_TTL_SECONDS
  });
}
async function touchCachedEntry(key, entry, kv) {
  entry.upstreamCheckedAt = Date.now();
  await setCachedEntry(key, entry, kv);
}
async function getBinaryCachedEntry(key, kv) {
  const result = await kv.getWithMetadata(key, "arrayBuffer");
  if (!result.value || !result.metadata)
    return null;
  return { data: result.value, meta: result.metadata };
}
async function setBinaryCachedEntry(key, data, meta, kv) {
  await kv.put(key, data, {
    expirationTtl: CACHE_TTL_SECONDS,
    metadata: meta
  });
}
async function touchBinaryCachedEntry(key, data, meta, kv) {
  meta.upstreamCheckedAt = Date.now();
  await setBinaryCachedEntry(key, data, meta, kv);
}

// src/proxy.ts
const TARGETS = {
  community: "steamcommunity.com",
  store: "store.steampowered.com",
  avatars: "avatars.cloudflare.steamstatic.com"
};
const FAKE_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const HEADERS_TO_REMOVE = [
  "host",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
  "cookie",
  "authorization",
  "connection",
  "upgrade-insecure-requests"
];
const RESPONSE_HEADERS_TO_REMOVE = [
  "content-length",
  "content-encoding",
  "content-md5",
  "etag",
  "set-cookie",
  "x-frame-options",
  "content-security-policy",
  "x-content-security-policy",
  "x-xss-protection",
  "strict-transport-security"
];
const FETCH_TIMEOUT_MS = 1e4;
const RETRY_DELAY_MS = 500;
const MAX_RETRIES = 1;
function getTarget(pathname) {
  if (pathname.startsWith("/id/") || pathname.startsWith("/profiles/")) {
    return {
      host: TARGETS.community,
      referer: "https://steamcommunity.com/",
      origin: "https://steamcommunity.com"
    };
  }
  if (pathname.startsWith("/api/")) {
    return {
      host: TARGETS.store,
      referer: "https://store.steampowered.com/",
      origin: "https://store.steampowered.com"
    };
  }
  if (pathname.startsWith("/avatar/")) {
    return {
      host: TARGETS.avatars,
      referer: "https://steamcommunity.com/",
      origin: "https://steamcommunity.com"
    };
  }
  return null;
}
function isBinaryPath(pathname) {
  return pathname.startsWith("/avatar/");
}
function buildUpstreamHeaders(originalHeaders, target) {
  const headers = new Headers();
  for (const [key, value] of originalHeaders) {
    const lowerKey = key.toLowerCase();
    if (!HEADERS_TO_REMOVE.includes(lowerKey) && !lowerKey.startsWith("cf-")) {
      headers.set(key, value);
    }
  }
  headers.set("Host", target.host);
  headers.set("User-Agent", FAKE_USER_AGENT);
  headers.set("Referer", target.referer);
  headers.set("Origin", target.origin);
  headers.set("Accept", "image/avif,image/webp,image/apng,*/*;q=0.8");
  headers.set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
  headers.set("Accept-Encoding", "gzip, deflate, br");
  headers.set("Cache-Control", "no-cache");
  headers.set("Pragma", "no-cache");
  headers.set("Sec-Ch-Ua", '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"');
  headers.set("Sec-Ch-Ua-Mobile", "?0");
  headers.set("Sec-Ch-Ua-Platform", '"Windows"');
  headers.set("Sec-Fetch-Dest", "image");
  headers.set("Sec-Fetch-Mode", "no-cors");
  headers.set("Sec-Fetch-Site", "cross-site");
  return headers;
}
function buildUpstreamHeadersText(originalHeaders, target) {
  const headers = new Headers();
  for (const [key, value] of originalHeaders) {
    const lowerKey = key.toLowerCase();
    if (!HEADERS_TO_REMOVE.includes(lowerKey) && !lowerKey.startsWith("cf-")) {
      headers.set(key, value);
    }
  }
  headers.set("Host", target.host);
  headers.set("User-Agent", FAKE_USER_AGENT);
  headers.set("Referer", target.referer);
  headers.set("Origin", target.origin);
  headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8");
  headers.set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8");
  headers.set("Accept-Encoding", "gzip, deflate, br");
  headers.set("Cache-Control", "no-cache");
  headers.set("Pragma", "no-cache");
  headers.set("Sec-Ch-Ua", '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"');
  headers.set("Sec-Ch-Ua-Mobile", "?0");
  headers.set("Sec-Ch-Ua-Platform", '"Windows"');
  headers.set("Sec-Fetch-Dest", "document");
  headers.set("Sec-Fetch-Mode", "navigate");
  headers.set("Sec-Fetch-Site", "same-origin");
  headers.set("Sec-Fetch-User", "?1");
  return headers;
}
function buildResponseHeaders(contentType, fromCache) {
  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, User-Agent");
  headers.set("X-Cache", fromCache ? "HIT" : "MISS");
  return headers;
}
function buildResponseHeadersFromUpstream(originalHeaders) {
  const headers = new Headers();
  for (const [key, value] of originalHeaders) {
    const lowerKey = key.toLowerCase();
    if (!RESPONSE_HEADERS_TO_REMOVE.includes(lowerKey)) {
      headers.set(key, value);
    }
  }
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type, User-Agent");
  headers.set("X-Cache", "MISS");
  return headers;
}
async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
async function fetchWithRetry(url, init, retries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchWithTimeout(url, init, FETCH_TIMEOUT_MS);
    } catch (err) {
      lastError = err;
      console.error(`Fetch attempt ${attempt + 1} failed for ${url}:`, err);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
  throw lastError;
}
async function proxyRequest(request, kv) {
  const url = new URL(request.url);
  if (isBinaryPath(url.pathname)) {
    return proxyBinaryRequest(request, kv);
  }
  return proxyTextRequest(request, kv);
}
function responseFromTextCache(entry) {
  const headers = buildResponseHeaders(entry.contentType, true);
  return new Response(entry.body, { status: entry.status, headers });
}
async function proxyTextRequest(request, kv) {
  const url = new URL(request.url);
  const target = getTarget(url.pathname);
  if (!target)
    return new Response(null, { status: 500 });
  const cacheKey = buildCacheKey(url.pathname, url.search);
  const cached = await getCachedEntry(cacheKey, kv);
  if (cached) {
    if (!shouldRevalidate(cached.upstreamCheckedAt)) {
      console.log(`Cache HIT (fresh): ${cacheKey}`);
      return responseFromTextCache(cached);
    }
    console.log(`Cache HIT (stale, revalidating): ${cacheKey}`);
    try {
      const fresh = await fetchTextUpstream(request, target);
      if (!fresh) {
        console.warn(`Upstream failed, returning stale cache: ${cacheKey}`);
        return responseFromTextCache(cached);
      }
      const freshHash = await computeHash(fresh.body);
      if (freshHash === cached.hash) {
        console.log(`Revalidated, content unchanged: ${cacheKey}`);
        await touchCachedEntry(cacheKey, cached, kv);
        return responseFromTextCache(cached);
      }
      console.log(`Revalidated, content CHANGED: ${cacheKey}`);
      const now = Date.now();
      const newEntry = {
        body: fresh.body,
        contentType: fresh.contentType,
        status: fresh.status,
        hash: freshHash,
        cachedAt: now,
        upstreamCheckedAt: now
      };
      await setCachedEntry(cacheKey, newEntry, kv);
      const headers = buildResponseHeaders(fresh.contentType, false);
      return new Response(fresh.body, { status: fresh.status, headers });
    } catch (err) {
      console.warn(`Revalidation error, returning stale cache: ${cacheKey}`, err);
      return responseFromTextCache(cached);
    }
  }
  console.log(`Cache MISS: ${cacheKey}`);
  try {
    const fresh = await fetchTextUpstream(request, target);
    if (!fresh)
      return new Response(null, { status: 500 });
    const hash = await computeHash(fresh.body);
    const now = Date.now();
    const entry = {
      body: fresh.body,
      contentType: fresh.contentType,
      status: fresh.status,
      hash,
      cachedAt: now,
      upstreamCheckedAt: now
    };
    await setCachedEntry(cacheKey, entry, kv);
    const headers = buildResponseHeadersFromUpstream(fresh.originalHeaders);
    headers.set("X-Cache", "MISS");
    return new Response(fresh.body, { status: fresh.status, headers });
  } catch (err) {
    console.error(`Upstream fetch failed: ${cacheKey}`, err);
    return new Response(null, { status: 500 });
  }
}
async function fetchTextUpstream(request, target) {
  const url = new URL(request.url);
  const upstreamUrl = new URL(url.pathname + url.search, `https://${target.host}`);
  const headers = buildUpstreamHeadersText(request.headers, target);
  try {
    const response = await fetchWithRetry(upstreamUrl.toString(), {
      method: request.method,
      headers,
      body: request.method !== "GET" && request.method !== "HEAD" ? request.body : null,
      redirect: "follow"
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const body = new TextDecoder().decode(await readLimited(response, 2 * 1024 * 1024));
    const contentType = response.headers.get("Content-Type") || "application/octet-stream";
    const cleanHeaders = new Headers();
    for (const [key, value] of response.headers) {
      if (!RESPONSE_HEADERS_TO_REMOVE.includes(key.toLowerCase())) {
        cleanHeaders.set(key, value);
      }
    }
    return { body, contentType, status: response.status, originalHeaders: cleanHeaders };
  } catch (err) {
    console.error(`fetchTextUpstream failed for ${upstreamUrl}:`, err);
    return null;
  }
}
function responseFromBinaryCache(data, meta) {
  const headers = buildResponseHeaders(meta.contentType, true);
  headers.set("Cache-Control", "public, max-age=86400");
  return new Response(data, { status: meta.status, headers });
}
async function proxyBinaryRequest(request, kv) {
  const url = new URL(request.url);
  const target = getTarget(url.pathname);
  if (!target)
    return new Response(null, { status: 500 });
  const upstreamPath = url.pathname.replace(/^\/avatar/, "");
  const cacheKey = buildCacheKey(url.pathname, url.search);
  const cached = await getBinaryCachedEntry(cacheKey, kv);
  if (cached) {
    if (!shouldRevalidate(cached.meta.upstreamCheckedAt)) {
      console.log(`Binary cache HIT (fresh): ${cacheKey}`);
      return responseFromBinaryCache(cached.data, cached.meta);
    }
    console.log(`Binary cache HIT (stale, revalidating): ${cacheKey}`);
    try {
      const fresh = await fetchBinaryUpstream(upstreamPath, target, request.headers);
      if (!fresh) {
        console.warn(`Upstream failed, returning stale binary cache: ${cacheKey}`);
        return responseFromBinaryCache(cached.data, cached.meta);
      }
      const freshHash = await computeHashBytes(fresh.data);
      if (freshHash === cached.meta.hash) {
        console.log(`Binary revalidated, content unchanged: ${cacheKey}`);
        await touchBinaryCachedEntry(cacheKey, cached.data, cached.meta, kv);
        return responseFromBinaryCache(cached.data, cached.meta);
      }
      console.log(`Binary revalidated, content CHANGED: ${cacheKey}`);
      const now = Date.now();
      const meta = {
        contentType: fresh.contentType,
        status: fresh.status,
        hash: freshHash,
        cachedAt: now,
        upstreamCheckedAt: now
      };
      await setBinaryCachedEntry(cacheKey, fresh.data, meta, kv);
      const headers = buildResponseHeaders(fresh.contentType, false);
      headers.set("Cache-Control", "public, max-age=86400");
      return new Response(fresh.data, { status: fresh.status, headers });
    } catch (err) {
      console.warn(`Binary revalidation error, returning stale cache: ${cacheKey}`, err);
      return responseFromBinaryCache(cached.data, cached.meta);
    }
  }
  console.log(`Binary cache MISS: ${cacheKey}`);
  try {
    const fresh = await fetchBinaryUpstream(upstreamPath, target, request.headers);
    if (!fresh)
      return new Response(null, { status: 500 });
    const hash = await computeHashBytes(fresh.data);
    const now = Date.now();
    const meta = {
      contentType: fresh.contentType,
      status: fresh.status,
      hash,
      cachedAt: now,
      upstreamCheckedAt: now
    };
    await setBinaryCachedEntry(cacheKey, fresh.data, meta, kv);
    const headers = buildResponseHeaders(fresh.contentType, false);
    headers.set("Cache-Control", "public, max-age=86400");
    return new Response(fresh.data, { status: fresh.status, headers });
  } catch (err) {
    console.error(`Binary upstream fetch failed: ${cacheKey}`, err);
    return new Response(null, { status: 500 });
  }
}
async function fetchBinaryUpstream(upstreamPath, target, originalHeaders) {
  const upstreamUrl = `https://${target.host}${upstreamPath}`;
  const headers = buildUpstreamHeaders(originalHeaders, target);
  try {
    const response = await fetchWithRetry(upstreamUrl, {
      method: "GET",
      headers,
      redirect: "follow"
    });
    if (!response.ok) {
      console.error(`Binary upstream returned ${response.status} for ${upstreamUrl}`);
      return null;
    }
    const data = await readLimited(response, 4 * 1024 * 1024);
    const contentType = response.headers.get("Content-Type") || "image/jpeg";
    return { data, contentType, status: response.status };
  } catch (err) {
    console.error(`fetchBinaryUpstream failed for ${upstreamUrl}:`, err);
    return null;
  }
}


export { validateRequest, isPathAllowed, proxyRequest };
