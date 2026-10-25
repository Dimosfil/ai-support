import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { SupportError, identity, requireThat } from '../core/domain.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
  ['/labels.js', ['labels.js', 'text/javascript']],
  ['/retry.js', ['retry.js', 'text/javascript']],
]);
const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

function json(response, status, value) {
  response.writeHead(status, { ...securityHeaders, 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}
async function body(request, maximum) {
  requireThat(request.headers['content-type']?.split(';')[0].trim() === 'application/json', 'json_required', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= maximum) chunks.push(chunk);
  }
  requireThat(size <= maximum, 'request_too_large', 413);
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requireThat(value && typeof value === 'object' && !Array.isArray(value), 'invalid_json');
    return value;
  } catch (error) {
    if (error instanceof SupportError) throw error;
    throw new SupportError('invalid_json');
  }
}
function fields(input, allowed) {
  requireThat(Object.keys(input).every(key => allowed.includes(key)), 'unknown_field');
  return input;
}
function pagination(url) {
  requireThat([...url.searchParams.keys()].every(key => ['before', 'limit'].includes(key)), 'unknown_query');
  requireThat(['before', 'limit'].every(key => url.searchParams.getAll(key).length <= 1), 'duplicate_query');
  const options = {};
  for (const key of ['before', 'limit']) {
    if (url.searchParams.has(key)) {
      requireThat(/^\d+$/.test(url.searchParams.get(key)), 'invalid_pagination');
      options[key] = Number(url.searchParams.get(key));
    }
  }
  return options;
}

/** Product hosts may supply their own trusted, revocation-aware identity adapter. */
export function createHttpServer({ service, authenticate, requestBytes = 65536, requestsPerMinute = 180, getDeliveryStatus = () => null }) {
  function deliveryAvailable() {
    try { return getDeliveryStatus()?.available === true; } catch { return false; }
  }
  const buckets = new Map();
  function throttle(request) {
    const minute = Math.floor(Date.now() / 60000);
    const key = request.socket.remoteAddress;
    let bucket = buckets.get(key);
    if (!bucket || bucket.minute !== minute) {
      for (const [address, value] of buckets) if (value.minute !== minute) buckets.delete(address);
      requireThat(buckets.size < 10000, 'server_busy', 503);
      bucket = { minute, count: 0 };
      buckets.set(key, bucket);
    }
    requireThat(++bucket.count <= requestsPerMinute, 'rate_limited', 429);
  }
  const server = createServer(async (request, response) => {
    try {
      throttle(request);
      const url = new URL(request.url, 'http://support.local');
      if (request.method === 'GET' && assets.has(url.pathname)) {
        const [filename, type] = assets.get(url.pathname);
        response.writeHead(200, { ...securityHeaders, 'Content-Type': `${type}; charset=utf-8` });
        response.end(await readFile(new URL(`../web/${filename}`, import.meta.url)));
        return;
      }
      if (url.pathname === '/health' && request.method === 'GET') {
        json(response, 200, { status: 'ok', contractVersion: 1 });
        return;
      }
      requireThat(url.pathname.startsWith('/api/v1/'), 'not_found', 404);
      const p = identity(await authenticate(request));
      if (request.method === 'GET' && url.pathname === '/api/v1/session') {
        json(response, 200, { principal: p, policy: service.policy,
          capabilities: { attachments: false, guest: false, telegram: false, externalDelivery: deliveryAvailable() } });
        return;
      }
      const route = /^\/api\/v1\/tickets(?:\/([a-f0-9-]{36})(?:\/(messages|audit|commands))?)?$/.exec(url.pathname);
      requireThat(route, 'not_found', 404);
      const [, id, operation] = route;
      if (request.method === 'GET') {
        const page = pagination(url);
        let value;
        if (!id) value = service.list(p, page);
        else if (operation === 'messages') value = service.messages(p, id, page);
        else if (operation === 'audit') value = service.audit(p, id, page);
        else { requireThat(!operation, 'not_found', 404); value = service.get(p, id); }
        json(response, 200, value);
        return;
      }
      requireThat(request.method === 'POST' && (!id || operation === 'commands'), 'method_not_allowed', 405);
      requireThat(!url.search, 'unknown_query');
      const input = await body(request, requestBytes);
      const key = request.headers['idempotency-key'];
      let result;
      if (!id) result = service.create(p, fields(input, ['subject', 'body']), key);
      else {
        const allowed = { message: ['type', 'version', 'body', 'visibility'], status: ['type', 'version', 'status'], assignment: ['type', 'version', 'assigned'] };
        requireThat(Object.hasOwn(allowed, input.type), 'invalid_command');
        result = service.change(p, id, fields(input, allowed[input.type]), key);
      }
      json(response, !id && !result.replayed ? 201 : 200, result);
    } catch (error) {
      const known = error instanceof SupportError;
      if (!known) server.emit('applicationError', error);
      if (!response.headersSent) {
        if (error.status === 429) response.setHeader('Retry-After', '60');
        json(response, known ? error.status : 503, { error: known ? error.code : 'service_unavailable' });
      } else response.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 40;
  return server;
}
