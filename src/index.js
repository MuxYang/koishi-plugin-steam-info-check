import { isPathAllowed, proxyRequest, validateRequest } from './proxy.js';
import { readLimited, resourceResponse, rewriteResources } from './assets.js';

const failure = () => new Response(null, { status: 500 });

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, User-Agent',
      } });
    }
    if (!['GET', 'HEAD'].includes(request.method)) return failure();
    try {
      const url = new URL(request.url);
      // Resources are content-addressed reads, never an arbitrary-URL proxy.
      if (url.pathname.startsWith('/res/')) {
        return await resourceResponse(request, env.CACHE);
      }
      if (!isPathAllowed(url.pathname) || !/^[a-fA-F0-9]{64}$/.test(env.SECRET_KEY || '')) return failure();
      if (!(await validateRequest(request, env.SECRET_KEY)).valid) return failure();
      // Use the same cached representation for GET and HEAD.
      const upstreamRequest = new Request(request.url, { method: 'GET', headers: request.headers });
      const response = await proxyRequest(upstreamRequest, env.CACHE);
      let body = response.body;
      const headers = new Headers(response.headers);
      const contentType = headers.get('content-type') || '';
      if (response.ok && /text\/html|text\/css/i.test(contentType)) {
        const text = new TextDecoder().decode(await readLimited(response, 2 * 1024 * 1024));
        body = await rewriteResources(text, url.origin, env.CACHE);
        // The rewritten representation differs from the upstream response.
        for (const header of ['content-length', 'content-encoding', 'etag', 'content-md5']) headers.delete(header);
      }
      // Never cache authenticated profile/API responses in a public intermediary.
      headers.set('Cache-Control', 'private, no-store');
      return new Response(request.method === 'HEAD' ? null : body, { status: response.status, headers });
    } catch {
      return failure();
    }
  },
};
