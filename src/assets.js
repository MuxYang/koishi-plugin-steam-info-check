const TTL = 30 * 24 * 60 * 60;
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ASSETS = 24;

export async function readLimited(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('Upstream response too large');
  }
  if (!response.body) return new ArrayBuffer(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Upstream response too large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  return data.buffer;
}

async function hash(data) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)),
    b => b.toString(16).padStart(2, '0')).join('');
}

function staticUrl(value, base) {
  try {
    const url = new URL(value.replace(/\\\//g, '/').replace(/&amp;/g, '&'), base);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    if (!(url.hostname.endsWith('.steamstatic.com') || url.hostname === 'steamcdn-a.akamaihd.net')) return null;
    if (url.pathname.endsWith('/')) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

export async function resourceResponse(request, kv) {
  const path = new URL(request.url).pathname;
  if (!/^\/res\/[a-f0-9]{64}$/.test(path)) return new Response(null, { status: 500 });
  const { value, metadata } = await kv.getWithMetadata('asset:' + path.slice(5), 'arrayBuffer');
  if (!value || !metadata) return new Response(null, { status: 500 });
  return new Response(request.method === 'HEAD' ? null : value, { headers: {
    'Content-Type': metadata.contentType,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
  } });
}

export async function rewriteResources(text, origin, kv) {
  const pending = new Map();
  let remaining = MAX_ASSETS;

  async function cacheAsset(url, depth) {
    // Do not wait on another top-level stylesheet while expanding its children.
    if (depth > 0 && pending.has(url)) return null;
    if (pending.has(url)) return pending.get(url);
    if (remaining-- <= 0) return null;
    const task = (async () => {
      try {
        const indexKey = 'asset-url:' + await hash(new TextEncoder().encode(origin + '\n' + url));
        const existing = await kv.get(indexKey, 'text');
        if (/^[a-f0-9]{64}$/.test(existing || '')) return origin + '/res/' + existing;
        // No client headers, tokens or cookies go to static-resource hosts.
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
        if (!response.ok) { await response.body?.cancel(); return null; }
        let data = await readLimited(response, MAX_BYTES);
        const contentType = response.headers.get('content-type') || 'application/octet-stream';
        if (/text\/css/i.test(contentType)) {
          // Imported stylesheets beyond this depth retain their upstream URL.
          if (depth >= 1) return null;
          data = new TextEncoder().encode(await rewrite(new TextDecoder().decode(data), url, depth + 1));
        }
        const digest = await hash(data);
        await kv.put('asset:' + digest, data, { expirationTtl: TTL, metadata: { contentType } });
        await kv.put(indexKey, digest, { expirationTtl: 86400 });
        return origin + '/res/' + digest;
      } catch { return null; }
    })();
    pending.set(url, task);
    return task;
  }

  async function rewrite(source, base, depth) {
    const candidates = new Map();
    const absolute = /(?:https?:)?(?:\\?\/){2}[^\s"'<>()[\]`]+/g;
    const clean = raw => raw.split(/&(?:quot|apos|lt|gt);/)[0].replace(/\\+$/, '');
    for (const match of source.matchAll(absolute)) {
      const raw = clean(match[0]);
      const url = staticUrl(raw, base);
      if (url) candidates.set(raw, url);
    }
    // CSS files can also reference fonts/images by relative URL.
    if (depth > 0) {
      for (const match of source.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)|@import\s+["']([^"']+)["']/gi)) {
        const raw = match[1] || match[2];
        const url = staticUrl(raw, base);
        if (url) candidates.set(raw, url);
      }
    }
    const replacements = new Map();
    const entries = [...candidates].slice(0, MAX_ASSETS);
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
      while (cursor < entries.length) {
        const [raw, url] = entries[cursor++];
        const replacement = await cacheAsset(url, depth);
        if (replacement) replacements.set(raw, raw.includes('\\/') ? replacement.replaceAll('/', '\\/') : replacement);
        else if (depth > 0) replacements.set(raw, url);
      }
    }));
    let result = source.replace(absolute, match => {
      const raw = clean(match);
      return replacements.has(raw) ? replacements.get(raw) + match.slice(raw.length) : match;
    });
    if (depth > 0) result = result.replace(/url\(\s*["']?([^"')\s]+)["']?\s*\)|@import\s+["']([^"']+)["']/gi,
      (match, url, imported) => match.replace(url || imported, replacements.get(url || imported) || (url || imported)));
    return result;
  }

  return rewrite(text, 'https://steamcommunity.com/', 0);
}
