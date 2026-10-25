import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore, SupportService } from '../src/index.mjs';
import { createHttpServer } from '../src/http/app.mjs';
import { localIdentityAdapter } from '../src/adapters/local-identity.mjs';

async function setup(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'support-http-'));
  const tokens = Object.fromEntries(['user', 'other', 'operator', 'foreign'].map(name => [name, randomBytes(32).toString('base64url')]));
  const records = Object.entries(tokens).map(([name, token]) => ({
    tenant: name === 'foreign' ? 'other-product' : 'product', subject: name,
    role: ['operator', 'foreign'].includes(name) ? 'operator' : 'user',
    tokenHash: createHash('sha256').update(token).digest('hex'),
  }));
  const filename = join(directory, 'identities.json');
  writeFileSync(filename, JSON.stringify(records));
  const store = new SqliteStore(':memory:');
  const server = createHttpServer({ service: new SupportService(store), authenticate: localIdentityAdapter(filename), ...options });
  const unexpected = [];
  server.on('applicationError', error => unexpected.push(error));
  server.listen(0, '127.0.0.1'); // Tests alone use an OS-assigned ephemeral listener.
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { who = 'user', data, key = 'http-operation-1', headers = {}, ...init } = {}) {
    const response = await fetch(`${base}${path}`, {
      ...init, method: data === undefined ? 'GET' : 'POST',
      headers: { ...(tokens[who] ? { Authorization: `Bearer ${tokens[who]}` } : {}),
        ...(data !== undefined ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}), ...headers },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  return { request, base, store, unexpected };
}

test('session reports configured delivery availability and isolates optional status failures', async t => {
  let available = true, broken = false;
  const { request } = await setup(t, { getDeliveryStatus: () => {
    if (broken) throw new Error('private adapter error');
    return { available };
  } });
  assert.equal((await request('/api/v1/session')).body.capabilities.externalDelivery, true);
  available = false;
  assert.equal((await request('/api/v1/session')).body.capabilities.externalDelivery, false);
  broken = true;
  const session = await request('/api/v1/session');
  assert.equal(session.status, 200);
  assert.equal(session.body.capabilities.externalDelivery, false);
  assert.equal(session.body.capabilities.telegram, false);
});

test('HTTP workflow: Unicode persistence, operator reply, private note, assignment and reopen', async t => {
  const { request, unexpected } = await setup(t);
  const created = await request('/api/v1/tickets', { data: { subject: 'Ошибка входа', body: 'Не могу войти — помогите' } });
  assert.equal(created.status, 201);
  const id = created.body.id, path = `/api/v1/tickets/${id}`;
  assert.equal((await request(`${path}/commands`, { who: 'operator', key: 'assign-op', data: { type: 'assignment', version: 1, assigned: true } })).status, 200);
  assert.equal((await request(`${path}/commands`, { who: 'operator', key: 'reply-op', data: { type: 'message', version: 2, body: 'Здравствуйте! Уже проверяем.' } })).status, 200);
  assert.equal((await request(`${path}/commands`, { who: 'operator', key: 'note-key', data: { type: 'message', version: 3, body: 'Скрытая заметка', visibility: 'internal' } })).status, 200);
  const history = await request(`${path}/messages`);
  assert.deepEqual(history.body.items.map(row => row.body), ['Здравствуйте! Уже проверяем.', 'Не могу войти — помогите']);
  assert.equal((await request(`${path}/messages`, { who: 'operator' })).body.items.length, 3);
  assert.equal((await request(`${path}/commands`, { who: 'operator', key: 'resolve-key', data: { type: 'status', version: 4, status: 'resolved' } })).status, 200);
  assert.equal((await request(`${path}/commands`, { key: 'reopen-key', data: { type: 'message', version: 5, body: 'Ещё не работает' } })).status, 200);
  assert.equal((await request(path)).body.status, 'in_progress');
  assert.equal((await request(`${path}/audit`, { who: 'operator' })).body.items.length, 6);
  assert.deepEqual(unexpected, []);
});

test('HTTP authentication and isolation reject spoofed tenant, subject and role', async t => {
  const { request } = await setup(t);
  assert.equal((await request('/api/v1/tickets', { who: 'anonymous', headers: { 'X-Role': 'operator', 'X-Tenant': 'product' } })).status, 401);
  const session = await request('/api/v1/session');
  assert.equal(session.body.capabilities.attachments, false);
  assert.equal(session.body.capabilities.externalDelivery, false);
  assert.equal((await request('/api/v1/tickets', { data: { subject: 'Тема', body: 'Текст', tenant: 'other-product' } })).status, 400);
  const { body: { id } } = await request('/api/v1/tickets', { data: { subject: 'Тема', body: 'Текст' } });
  for (const who of ['other', 'foreign']) {
    assert.equal((await request(`/api/v1/tickets/${id}`, { who })).status, 404);
    assert.equal((await request(`/api/v1/tickets/${id}/messages`, { who })).status, 404);
    assert.equal((await request('/api/v1/tickets', { who })).body.items.length, 0);
  }
  assert.equal((await request(`/api/v1/tickets/${id}/audit`)).status, 403);
  assert.equal((await request(`/api/v1/tickets/${id}/commands`, { who: 'operator', data: { type: '__proto__', version: 1 } })).status, 400);
  assert.deepEqual((await request(`/api/v1/tickets/${id}`)).body.allowedTransitions, []);
  assert.deepEqual((await request(`/api/v1/tickets/${id}`, { who: 'operator' })).body.allowedTransitions, ['in_progress', 'resolved']);
});

test('HTTP retry after discarded response and competing version produce no duplicate messages', async t => {
  const { request } = await setup(t);
  const data = { subject: 'Повтор', body: 'Первое сообщение' };
  const original = await request('/api/v1/tickets', { data });
  const repeated = await request('/api/v1/tickets', { data });
  assert.equal(repeated.body.id, original.body.id);
  assert.equal(repeated.body.replayed, true);
  const path = `/api/v1/tickets/${original.body.id}`;
  const commands = ['Первый ответ', 'Конкурентный ответ'].map((body, index) => request(`${path}/commands`, {
    who: 'operator', key: `parallel-${index}`, data: { type: 'message', version: 1, body },
  }));
  const results = await Promise.all(commands);
  assert.deepEqual(results.map(row => row.status).sort(), [200, 409]);
  assert.equal((await request(`${path}/messages`)).body.items.length, 2);
});

test('HTTP validates JSON, pagination, unsupported attachments and request size', async t => {
  const { request, base } = await setup(t, { requestBytes: 128 });
  for (const query of ['?limit=0', '?before=-1', '?limit=1&limit=2', '?limit=NaN', '?owner=other'])
    assert.equal((await request(`/api/v1/tickets${query}`)).status, 400);
  assert.equal((await request('/api/v1/tickets', { data: { subject: 'Title', body: 'a'.repeat(200) } })).status, 413);
  assert.equal((await request('/api/v1/tickets', { data: { subject: 'Title', body: 'Text', attachments: [] } })).status, 400);
  assert.equal((await request('/api/v1/tickets', { data: { subject: 'Title', body: 'Text' }, headers: { 'Idempotency-Key': '' } })).status, 400);
  const invalid = await fetch(`${base}/api/v1/tickets`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(invalid.status, 401); // Authenticate before parsing or persisting user data.
});

test('HTTP denies acceptance on storage failure and returns a sanitized error', async t => {
  const { request, store, unexpected } = await setup(t);
  store.enqueue = () => { throw new Error('sensitive internal detail'); };
  const result = await request('/api/v1/tickets', { data: { subject: 'Тема', body: 'Текст' } });
  assert.equal(result.status, 503);
  assert.deepEqual(result.body, { error: 'service_unavailable' });
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM tickets').get().n, 0);
  assert.equal(unexpected.length, 1);
});

test('HTTP static surface is public, applies CSP and does not expose local files', async t => {
  const { base } = await setup(t);
  for (const asset of ['/', '/app.js', '/labels.js', '/style.css']) {
    const response = await fetch(`${base}${asset}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok((await response.text()).length > 0);
  }
  assert.equal((await fetch(`${base}/.local/access.txt`)).status, 404);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test('HTTP ingress rate limit is bounded and advertises retry', async t => {
  const { request } = await setup(t, { requestsPerMinute: 1 });
  assert.equal((await request('/health')).status, 200);
  const limited = await request('/health');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
});
