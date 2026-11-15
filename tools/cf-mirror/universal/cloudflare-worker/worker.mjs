/**
 * CF Mirror Universal — VPN-free edge entrypoint (Cloudflare Workers).
 *
 * This Worker is a narrow, same-origin reverse proxy to an expiring,
 * password-protected CF Mirror gateway at https://*.trycloudflare.com.
 * It does NOT expose CDP, X11 or the backend ports. It does NOT terminate
 * or weaken upstream authentication, CSRF, cookies or expiry.
 *
 * Required Wrangler vars:
 *   MIRROR_UPSTREAM  = https://...trycloudflare.com
 *   PUBLIC_ORIGIN    = https://cf-mirror-bridge.<ACCOUNT>.workers.dev
 * Optional:
 *   MIRROR_EXPIRES_AT = Unix milliseconds, same as the source gateway.
 */
const WS_PATHS = new Map([
  ['/input-ws', 'cfm-input'],
  ['/mic-ws', 'cfm-mic'],
]);
const ALLOWED_HTTP = new Set(['GET', 'HEAD', 'POST']);
const FORWARD_HEADERS = [
  'accept', 'accept-language', 'cache-control', 'content-type', 'cookie',
  'if-modified-since', 'if-none-match', 'pragma', 'range',
  'user-agent', 'x-cf-mirror-csrf',
];
const NO_STORE = 'no-store, private, max-age=0, no-transform';

function reply(status, body, extra = {}) {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': NO_STORE,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...extra,
    },
  });
}

function configured(env) {
  let upstream, publicOrigin;
  try {
    upstream = new URL(env.MIRROR_UPSTREAM || '');
    publicOrigin = new URL(env.PUBLIC_ORIGIN || '');
  } catch {
    return null;
  }
  // Only a non-authoritative quick tunnel (or explicitly approved fixed
  // HTTPS relay) may serve as origin. Block credentials and query/fragments.
  if (upstream.protocol !== 'https:' ||
      !/^[a-z0-9-]+\.trycloudflare\.com$/i.test(upstream.hostname) ||
      upstream.pathname !== '/' || upstream.search || upstream.hash ||
      upstream.username || upstream.password || upstream.port) return null;
  if (publicOrigin.protocol !== 'https:' ||
      !/^[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/i.test(publicOrigin.hostname) ||
      publicOrigin.pathname !== '/' || publicOrigin.search ||
      publicOrigin.hash || publicOrigin.username || publicOrigin.password) return null;
  const expiry = Number(env.MIRROR_EXPIRES_AT || 0);
  if (env.MIRROR_EXPIRES_AT &&
      (!Number.isSafeInteger(expiry) || expiry <= 0)) return null;
  return { upstream, publicOrigin, expiry };
}

function validateBrowser(request, incoming, isWs) {
  const origin = request.headers.get('origin');
  const site = request.headers.get('sec-fetch-site');
  const mutating = request.method === 'POST' || isWs;
  if (origin && origin !== incoming.origin) return false;
  if (mutating && site && !['same-origin', 'none'].includes(site)) return false;
  if (isWs && origin !== incoming.origin) return false;
  // Missing Origin on POST is allowed only because the gateway separately
  // verifies session-scoped login CSRF and signed control headers.
  return true;
}

function outboundHeaders(request, upstream, isWs) {
  const headers = new Headers();
  for (const k of FORWARD_HEADERS) {
    const v = request.headers.get(k);
    if (v !== null) headers.set(k, v);
  }
  // Replacing Origin is safe ONLY after validateBrowser checked the public
  // origin. The private gateway's originOK check still sees its own origin.
  if (request.headers.has('origin')) headers.set('origin', upstream.origin);
  if (isWs) {
    headers.set('origin', upstream.origin);
    headers.set('upgrade', 'websocket');
    const protocols = request.headers.get('sec-websocket-protocol');
    if (protocols) headers.set('sec-websocket-protocol', protocols);
  }
  return headers;
}

function adjustedCsp(csp, publicOrigin) {
  if (!csp) return csp;
  const wss = 'wss://' + publicOrigin.host;
  // Gateway CSP uses a per-session trycloudflare WSS origin.
  // Replace it with the public worker socket origin; do not broaden rules.
  const directive = "connect-src 'self' " + wss + ';';
  return /(?:^|;\s*)connect-src\s+[^;]*(?:;|$)/i.test(csp)
    ? csp.replace(/connect-src\s+[^;]*(?:;|$)/i, directive)
    : csp + '; ' + directive;
}

function responseForBrowser(response, config, requestUrl) {
  const headers = new Headers(response.headers);
  headers.set('cache-control', NO_STORE);
  headers.delete('content-length'); // Stream is not buffered or re-sized.
  headers.delete('transfer-encoding');
  // Keep Content-Encoding intact: origin may serve compressed HTML/JSON.
  // Cloudflare Workers can preserve encoded bytes with encodeBody=manual.
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  const csp = headers.get('content-security-policy');
  if (csp) headers.set('content-security-policy', adjustedCsp(csp, config.publicOrigin));
  const location = headers.get('location');
  if (location) {
    try {
      const next = new URL(location, config.upstream.origin);
      if (next.origin === config.upstream.origin) {
        headers.set('location', config.publicOrigin.origin + next.pathname + next.search + next.hash);
      }
    } catch {
      headers.delete('location');
    }
  }
  // The gateway's Set-Cookie is host-only (no Domain), so it is stored under
  // workers.dev and automatically forwarded by browser on subsequent calls.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    encodeBody: 'manual',
  });
}

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    const config = configured(env);
    if (!config) return reply(503, 'Mirror Worker is not configured for an active HTTPS origin');
    if (incoming.origin !== config.publicOrigin.origin) {
      return reply(421, 'Unexpected Worker hostname');
    }
    if (config.expiry && Date.now() >= config.expiry) {
      return reply(410, 'Mirror session expired');
    }
    if (incoming.pathname === '/__bridge-health' && request.method === 'GET') {
      // Only routing status, no session token, source address, or browser info.
      return Response.json(
        { ok: true, proxy: 'cf-mirror-universal', version: '2026-11-15.1',
          configured: true, expired: false },
        { headers: { 'cache-control': NO_STORE } }
      );
    }
    const upgrade = request.headers.get('upgrade')?.toLowerCase();
    const isWs = upgrade === 'websocket';
    if (!ALLOWED_HTTP.has(request.method)) return reply(405, 'Method not allowed');
    if (isWs && (!WS_PATHS.has(incoming.pathname) || request.method !== 'GET')) {
      return reply(404, 'WebSocket route not found');
    }
    if (!validateBrowser(request, incoming, isWs)) return reply(403, 'Origin denied');
    if (isWs) {
      const offered = (request.headers.get('sec-websocket-protocol') || '')
        .split(',').map(x => x.trim());
      const expectedProtocol = WS_PATHS.get(incoming.pathname);
      const signed = offered.some(x => /^[a-zA-Z0-9_-]{43}$/.test(x));
      if (!offered.includes(expectedProtocol) || !signed) {
        return reply(403, 'WebSocket control token required');
      }
      // A browser cannot read this cookie; the gateway still validates it,
      // together with the HMAC session token and source expiry.
      if (!/(?:^|;\s*)cfm_auth=[A-Za-z0-9_-]{24,100}(?:;|$)/.test(
        request.headers.get('cookie') || '')) {
        return reply(401, 'Password required');
      }
    }
    const target = new URL(config.upstream.origin);
    target.pathname = incoming.pathname;
    target.search = incoming.search;
    const headers = outboundHeaders(request, config.upstream, isWs);
    let upstream;
    try {
      if (isWs) {
        // Cloudflare Workers handles Sec-WebSocket-Key and returns a 101
        // Response with webSocket; returning it directly provides a binary-
        // transparent bridge for /input-ws and /mic-ws (no frame decoding).
        upstream = await fetch(target.href, { headers, redirect: 'manual' });
        if (upstream.status === 101 && upstream.webSocket) return upstream;
        return reply(502, 'Mirror WebSocket backend unavailable');
      }
      upstream = await fetch(target.href, {
        method: request.method,
        headers,
        body: request.method === 'POST' ? request.body : undefined,
        redirect: 'manual',
        // Response.body is streamed; do not buffer MJPEG into memory.
      });
      return responseForBrowser(upstream, config, incoming);
    } catch {
      return reply(502, 'Mirror tunnel unavailable');
    }
  },
};
