import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCipheriv, randomBytes } from 'node:crypto';
import worker from '../src/index.js';
import { readLimited, rewriteResources } from '../src/assets.js';

const SECRET_KEY = '01'.repeat(32); // Test fixture, never a deployment secret.
function token(timestamp = Date.now()) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(SECRET_KEY, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(`0.0.0.0:${timestamp}:${randomBytes(8).toString('hex')}`), cipher.final()]);
  return 'SteamSpeedService/' + Buffer.concat([iv, ciphertext, cipher.getAuthTag()]).toString('base64url');
}
function kv() {
  const entries = new Map();
  return {
    async get(key) { return entries.get(key)?.value ?? null; },
    async put(key, value, options = {}) {
      const stored = typeof value === 'string' ? value : new Uint8Array(value).slice().buffer;
      entries.set(key, { value: stored, metadata: options.metadata });
    },
    async getWithMetadata(key) { return entries.get(key) || { value: null, metadata: null }; },
  };
}
function request(path, ua = token(), method = 'GET') {
  return new Request('https://proxy.example.com' + path, { method, headers: { 'User-Agent': ua } });
}

test('validates AES-GCM tokens, rejects expiry, replay and unsupported paths/methods', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('Steam', { headers: { 'content-type': 'text/plain' } }));
  const env = { SECRET_KEY, CACHE: kv() };
  const ua = token();
  assert.equal((await worker.fetch(request('/profiles/1', ua), env)).status, 200);
  assert.equal((await worker.fetch(request('/profiles/1', ua), env)).status, 500);
  assert.equal((await worker.fetch(request('/profiles/1', token(Date.now() - 11000)), env)).status, 500);
  assert.equal((await worker.fetch(request('/profiles/1', ''), env)).status, 500);
  assert.equal((await worker.fetch(request('/unknown'), env)).status, 500);
  assert.equal((await worker.fetch(request('/profiles/1', token(), 'POST'), env)).status, 500);
});

test('HTML, CSS and escaped inline URLs become absolute content-addressed resources', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, init) => {
    const url = String(input); calls.push(url);
    if (url.includes('steamcommunity.com/profiles')) {
      assert.equal(new Headers(init.headers).get('cookie'), null);
      assert.doesNotMatch(new Headers(init.headers).get('user-agent'), /SteamSpeedService/);
      return new Response('<link href="https://cdn.steamstatic.com/style.css"><img src="https://cdn.steamstatic.com/a.png"><script>let x="https:\\/\\/cdn.steamstatic.com\\/a.png"</script>',
        { headers: { 'content-type': 'text/html', 'content-length': '999', 'content-encoding': 'gzip' } });
    }
    if (url.endsWith('/style.css')) return new Response('a{background:url(./a.png)} @font-face{src:url(../font.woff2)}', { headers: { 'content-type': 'text/css' } });
    return new Response('static bytes', { headers: { 'content-type': url.endsWith('.png') ? 'image/png' : 'font/woff2' } });
  });
  const env = { SECRET_KEY, CACHE: kv() };
  const incoming = request('/profiles/123');
  incoming.headers.set('cookie', 'private=secret');
  const response = await worker.fetch(incoming, env);
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /https:\/\/proxy\.example\.com\/res\/[a-f0-9]{64}/);
  assert.match(text, /https:\\\/\\\/proxy\.example\.com\\\/res\\\/[a-f0-9]{64}/);
  assert.equal(response.headers.get('content-length'), null);
  assert.equal(response.headers.get('content-encoding'), null);
  const cssUrl = /href="([^"]+)"/.exec(text)[1];
  const css = await worker.fetch(new Request(cssUrl), env);
  assert.match(await css.text(), /url\(https:\/\/proxy\.example\.com\/res\/[a-f0-9]{64}\)/);
  const imageUrl = /<img src="([^"]+)"/.exec(text)[1];
  const image = await worker.fetch(new Request(imageUrl), env);
  assert.equal(await image.text(), 'static bytes');
  assert.match(image.headers.get('cache-control'), /immutable/);
  assert.equal((await worker.fetch(new Request(imageUrl, { method: 'HEAD' }), env)).body, null);
  assert.equal((await worker.fetch(request('/res/' + '0'.repeat(64), ''), env)).status, 500);
  assert.equal(calls.filter(url => url.endsWith('/a.png')).length, 1);
});

test('only fetches allowlisted CDN resources and keeps failures and CDN base URLs intact', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async input => { calls.push(String(input)); return new Response(null, { status: 404 }); });
  const source = '<img src="https://steamstatic.com.evil.example/a.png"><img src="https://cdn.steamstatic.com/missing.png"><script>const base="https://cdn.steamstatic.com/public/";</script>';
  assert.equal(await rewriteResources(source, 'https://proxy.example.com', kv()), source);
  assert.deepEqual(calls, ['https://cdn.steamstatic.com/missing.png']);
});

test('bounds response sizes even without Content-Length', async () => {
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20)); controller.close(); } }));
  await assert.rejects(readLimited(response, 10), /too large/);
});

test('redirecting CDN resources never bypass the allowlist', async t => {
  t.mock.method(globalThis, 'fetch', async (_, init) => {
    assert.equal(init.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  });
  const source = '<img src="https://cdn.steamstatic.com/redirect.png">';
  assert.equal(await rewriteResources(source, 'https://proxy.example.com', kv()), source);
});

test('stylesheet self-import cannot deadlock and failed relative resources stay absolute', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('@import "./style.css"; a{background:url(./missing.png)}', { headers: { 'content-type': 'text/css' } }));
  const cache = kv();
  const html = await rewriteResources('<link href="https://cdn.steamstatic.com/style.css">', 'https://proxy.example.com', cache);
  const css = await worker.fetch(new Request(/href="([^"]+)"/.exec(html)[1]), { CACHE: cache });
  const text = await css.text();
  assert.match(text, /@import "https:\/\/cdn\.steamstatic\.com\/style.css"/);
  assert.match(text, /url\(https:\/\/cdn\.steamstatic\.com\/missing.png\)/);
});
