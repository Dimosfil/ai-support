import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SqliteStore, SupportService, SqliteDeliveryStore, NotificationDispatcher,
  createTelegramTransport, createProductTransport, createSupportIngress } from '../src/index.mjs';
import { migrateDeliveryStorage } from '../src/storage/migrate-delivery.mjs';
import { startConfiguredDelivery } from '../src/delivery/runtime.mjs';

const user = { tenant: 'media', subject: 'account-a', role: 'user' };
const operator = { tenant: 'media', subject: 'operator-a', role: 'operator' };
const recipient = (id = 'operator-tg', channel = 'telegram', principal = operator) => ({
  id, channel, principal, binding: 'binding-v1', enabled: true, address: '12345'
});
const snapshot = value => { const { id, channel, principal, binding } = value; return { id, channel, binding, principal }; };
const create = service => service.create(user, { subject: 'Ошибка оплаты', body: 'Помогите, пожалуйста 🦊' }, 'create-event-01');
const rows = store => store.db.prepare('SELECT * FROM notification_deliveries ORDER BY intent_seq,id').all();

function setup(t, { filename = ':memory:' } = {}) {
  const store = new SqliteStore(filename);
  t.after(() => store.close());
  return { store, service: new SupportService(store), delivery: new SqliteDeliveryStore(store) };
}
function dispatcher(delivery, options = {}) {
  return new NotificationDispatcher({ store: delivery,
    resolveRecipients: async () => [recipient()], revalidateRecipient: async () => recipient(),
    transports: { telegram: { send: async () => ({ state: 'sent' }) } }, ...options });
}
function temporary() {
  const dir = mkdtempSync(join(tmpdir(), 'support-delivery-'));
  return dir;
}
async function receiver(t, handle) {
  const server = createServer(async (req, res) => {
    try {
      const parts = [];
      for await (const part of req) parts.push(part);
      const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
      await handle(req, res, body);
    } catch { res.writeHead(500); res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const reply = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };

test('atomic intent delivers through real Telegram/product HTTP transports, Unicode and per-recipient state', async t => {
  const { store, service, delivery } = setup(t), received = [];
  const base = await receiver(t, (req, res, body) => {
    received.push({ url: req.url, body, key: req.headers['idempotency-key'], auth: req.headers.authorization });
    if (req.url.endsWith('/sendMessage')) reply(res, 200, { ok: true, result: { message_id: 777 } });
    else reply(res, 200, { accepted: true });
  });
  const receipt = create(service);
  const targets = [recipient(), recipient('operator-service', 'product')];
  const worker = dispatcher(delivery, {
    resolveRecipients: async () => targets,
    revalidateRecipient: async old => targets.find(row => row.id === old.id),
    transports: {
      telegram: createTelegramTransport({ token: '123:private-token', baseUrl: base }),
      product: createProductTransport({ url: `${base}/notifications`, token: 'private-service-token' })
    }
  });
  await worker.runOnce();
  await worker.runOnce();
  assert.equal(received.length, 2);
  assert.ok(received.find(row => row.url.endsWith('/sendMessage')).body.text.includes('Помогите, пожалуйста 🦊'));
  const product = received.find(row => row.url === '/notifications');
  assert.equal(product.body.notification.ticketId, receipt.id);
  assert.equal(product.body.notification.body, 'Помогите, пожалуйста 🦊');
  assert.equal(product.key, product.body.notification.id);
  assert.equal(product.auth, 'Bearer private-service-token');
  assert.deepEqual(rows(store).map(row => row.state), ['sent', 'sent']);
  assert.equal(worker.status().intents.sent, 1);
  assert.ok(!JSON.stringify(rows(store)).includes('private-token'));
  assert.ok(!JSON.stringify(rows(store)).includes('Помогите'));
});

test('Telegram and product input share one ticket; repeated Telegram update is pinned across support selection changes', async t => {
  const { service, store } = setup(t);
  let auth = user;
  const binding = { principal: user, enabled: true, binding: 'link-1', support: { active: true, action: 'create', subject: 'Из Telegram' } };
  const ingress = createSupportIngress({ service, store, authenticateProduct: async () => auth, authenticateTelegram: async () => true,
    resolveTelegram: async () => binding, telegramSource: 'media-bot' });
  const update = { update_id: 100, message: { text: 'Текст из ТГ', from: { id: 12345 }, chat: { id: 12345, type: 'private' } } };
  const receipt = await ingress.fromTelegram(update);
  const otherTicket = service.create(user, { subject: 'Другой', body: 'Другое обращение' }, 'another-ticket-01');
  binding.support = { active: true, action: 'reply', ticketId: otherTicket.id, version: 1 };
  assert.equal((await ingress.fromTelegram(update)).id, receipt.id);
  assert.equal((await ingress.fromTelegram(update)).replayed, true);
  await ingress.fromProduct({}, { action: 'reply', ticketId: receipt.id, version: 1, body: 'Ответ из сервиса' }, 'product-reply-01');
  const history = service.messages(user, receipt.id).items;
  assert.deepEqual(history.map(row => row.body), ['Ответ из сервиса', 'Текст из ТГ']);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM notification_intents').get().n, 3);
  auth = { ...user, subject: 'other-account' };
  await assert.rejects(ingress.fromProduct({}, { action: 'reply', ticketId: receipt.id, version: 2, body: 'Чужой ответ' }, 'foreign-reply-01'));
  binding.principal = auth; binding.binding = 'new-link';
  await assert.rejects(ingress.fromTelegram(update), error => error.code === 'idempotency_conflict');
});

test('Telegram refuses group chats, unlinked accounts and generation-mode messages; ingress receipt failure rolls back all core writes', async t => {
  const { service, store } = setup(t);
  let binding = null;
  const ingress = createSupportIngress({ service, store, authenticateTelegram: async () => true,
    resolveTelegram: async () => binding, telegramSource: 'media-bot' });
  const update = { update_id: 1, message: { text: 'Не генерация', from: { id: 5 }, chat: { id: 5, type: 'private' } } };
  await assert.rejects(ingress.fromTelegram(update), error => error.code === 'telegram_binding_required');
  binding = { principal: user, enabled: true, binding: 'x', support: { active: false } };
  await assert.rejects(ingress.fromTelegram(update), error => error.code === 'support_mode_required');
  await assert.rejects(ingress.fromTelegram({ ...update, message: { ...update.message, chat: { id: 5, type: 'group' } } }));
  binding.support = { active: true, action: 'create', subject: 'Помощь' };
  store.db.exec("CREATE TRIGGER reject_ingress BEFORE INSERT ON support_inbound_receipts BEGIN SELECT RAISE(ABORT,'fail'); END");
  await assert.rejects(ingress.fromTelegram(update));
  for (const table of ['tickets','messages','notification_intents','audit','idempotency'])
    assert.equal(store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
});

test('internal notes create no delivery; audience/tenant are checked and revoked links never send', async t => {
  const { service, store, delivery } = setup(t);
  const receipt = create(service);
  service.change(operator, receipt.id, { type: 'message', version: 1, visibility: 'internal', body: 'Секрет оператора' }, 'internal-note-01');
  let sent = 0;
  const worker = dispatcher(delivery, { revalidateRecipient: async () => ({ ...recipient(), binding: 'relinked' }),
    transports: { telegram: { send: async () => { sent++; return { state: 'sent' }; } } } });
  await worker.runOnce();
  assert.equal(sent, 0);
  assert.equal(rows(store).length, 1);
  assert.equal(rows(store)[0].state, 'skipped');
  assert.equal(worker.status().intents.failed, 1); // Suppression is not reported as delivery.
  const fresh = service.create(user, { subject: 'Ещё', body: 'Вопрос' }, 'new-ticket-123');
  const malicious = dispatcher(delivery, { policy: { maxAttempts: 1 },
    resolveRecipients: async () => [recipient('foreign', 'telegram', { ...operator, tenant: 'other-product' })] });
  await malicious.runOnce();
  assert.equal(store.db.prepare('SELECT state FROM notification_intents WHERE ticket_id=?').get(fresh.id).state, 'failed');
  assert.equal(rows(store).length, 1);
});

test('operator public reply goes only to current ticket owner; internal text never leaves the store', async t => {
  const { service, delivery } = setup(t), payloads = [];
  const receipt = create(service);
  service.change(operator, receipt.id, { type: 'message', version: 1, body: 'Ответ оператора' }, 'operator-message');
  const worker = dispatcher(delivery, {
    resolveRecipients: async context => [recipient(context.audience, 'product', context.audience === 'owner' ? user : operator)],
    revalidateRecipient: async old => ({ ...old, enabled: true, address: 'host-route' }),
    transports: { product: { send: async value => { payloads.push(value); return { state: 'sent' }; } } }
  });
  await worker.runOnce();
  assert.equal(payloads.length, 2);
  assert.equal(payloads[1].recipient.principal.subject, user.subject);
  assert.equal(payloads[1].notification.body, 'Ответ оператора');
});

test('explicit Telegram rejection retries with backoff and respects long retry-after', async t => {
  const { service, delivery, store } = setup(t);
  create(service);
  let now = 100, attempts = 0;
  const base = await receiver(t, (_req, res) => {
    attempts++;
    if (attempts === 1) reply(res, 429, { ok: false, error_code: 429, parameters: { retry_after: 120 } });
    else reply(res, 200, { ok: true, result: { message_id: 1 } });
  });
  const worker = dispatcher(delivery, { clock: () => now,
    transports: { telegram: createTelegramTransport({ token: '1:test', baseUrl: base }) } });
  await worker.runOnce();
  assert.equal(rows(store)[0].next_at, 120100);
  now = 60100; await worker.runOnce(); assert.equal(attempts, 1);
  now = 120100; await worker.runOnce(); assert.equal(attempts, 2);
  assert.equal(rows(store)[0].state, 'sent');
  assert.deepEqual(store.db.prepare('SELECT outcome FROM notification_attempts ORDER BY attempt').all().map(row => row.outcome), ['pending','sent']);
});

test('unknown HTTP outcome is retained and never automatically retried', async t => {
  const { service, store, delivery } = setup(t);
  create(service);
  let requests = 0;
  const base = await receiver(t, (req, _res) => { requests++; req.socket.destroy(); });
  const worker = dispatcher(delivery, { transports: { telegram: createTelegramTransport({ token: '1:test', baseUrl: base }) } });
  await worker.runOnce(); await worker.runOnce();
  assert.equal(requests, 1);
  assert.equal(rows(store)[0].state, 'unknown');
  assert.equal(worker.status().intents.failed, 1);
});

test('pending deliveries survive reopen; crashed in-flight send becomes unknown; two workers do not duplicate sends', async t => {
  const dir = temporary(), filename = join(dir, 'support.sqlite');
  let now = 100;
  let store = new SqliteStore(filename);
  const service = new SupportService(store), initial = new SqliteDeliveryStore(store);
  create(service);
  const plan = initial.claimPlan(now, 100, 3);
  initial.finishPlan(plan, [snapshot(recipient())], now);
  const inFlight = initial.claimDelivery(now, 100);
  assert.equal(initial.beginSend(inFlight, now), true);
  store.close();
  store = new SqliteStore(filename);
  const secondStore = new SqliteStore(filename);
  t.after(() => { secondStore.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  now = 201;
  let sends = 0;
  const options = { clock: () => now, transports: { telegram: { send: async () => { sends++; return { state: 'sent' }; } } } };
  const a = dispatcher(new SqliteDeliveryStore(store), options), b = dispatcher(new SqliteDeliveryStore(secondStore), options);
  await a.runOnce();
  assert.equal(rows(store)[0].state, 'unknown');
  new SupportService(store).create(user, { subject: 'Новый', body: 'После перезапуска' }, 'restart-event-02');
  await Promise.all([a.runOnce(), b.runOnce()]);
  assert.equal(sends, 1);
  assert.deepEqual(rows(store).map(row => row.state), ['unknown', 'sent']);
});

test('bounded retries fail; recipient resolution errors and missing configuration never affect saved tickets', async t => {
  const { service, store, delivery } = setup(t);
  create(service);
  let now = 1, sends = 0;
  const worker = dispatcher(delivery, { clock: () => now, policy: { maxAttempts: 2, baseDelayMs: 10 },
    transports: { telegram: { send: async () => { sends++; return { state: 'retry' }; } } } });
  await worker.runOnce(); now += 10; await worker.runOnce(); now += 100; await worker.runOnce();
  assert.equal(sends, 2);
  assert.equal(rows(store)[0].state, 'failed');
  assert.equal(service.list(user).items.length, 1);
  const reports = [];
  assert.equal(await startConfiguredDelivery({ config: {}, store, service }), null);
  assert.equal(await startConfiguredDelivery({ config: { delivery: { enabled: true } }, store, service, report: code => reports.push(code) }), null);
  assert.deepEqual(reports, ['delivery_disabled']);
});

test('v1 remains usable without auto-migration; explicit v2 migration creates a restorable consistent backup', async t => {
  const dir = temporary(), filename = join(dir, 'old.sqlite'), backupPath = join(dir, 'backup.sqlite');
  const original = new DatabaseSync(filename);
  original.exec(readFileSync(new URL('../src/storage/schema.sql', import.meta.url), 'utf8'));
  original.close();
  let store = new SqliteStore(filename);
  const service = new SupportService(store), receipt = create(service);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.throws(() => new SqliteDeliveryStore(store), /delivery_schema_required/);
  store.close();
  await migrateDeliveryStorage(filename, backupPath);
  assert.ok(existsSync(backupPath));
  store = new SqliteStore(filename);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(new SupportService(store).get(user, receipt.id).subject, 'Ошибка оплаты');
  await dispatcher(new SqliteDeliveryStore(store)).runOnce();
  assert.equal(rows(store)[0].state, 'sent');
  const restored = new SqliteStore(backupPath);
  assert.equal(restored.db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(new SupportService(restored).get(user, receipt.id).id, receipt.id);
  restored.close();
  await assert.rejects(migrateDeliveryStorage(filename, backupPath));
});

test('transports reject unsafe endpoints and do not follow redirects with credentials', async t => {
  for (const url of ['http://example.com/notify', 'https://user:secret@example.com/', 'https://example.com/?token=secret'])
    assert.throws(() => createProductTransport({ url, token: 'test' }));
  let leaked = false;
  const destination = await receiver(t, (_req, res) => { leaked = true; reply(res, 200, { accepted: true }); });
  const base = await receiver(t, (_req, res) => { res.writeHead(307, { location: destination }); res.end(); });
  const transport = createProductTransport({ url: base, token: 'private-token' });
  assert.equal((await transport.send({ recipient: recipient(), notification: { id: 'id' }, signal: AbortSignal.timeout(1000) })).state, 'unknown');
  assert.equal(leaked, false);
});

test('one channel failure never resends successful recipients; permissions are rechecked on retry', async t => {
  const { service, store, delivery } = setup(t);
  create(service);
  let now = 1, linked = true;
  const attempts = [];
  const targets = [recipient('a'), recipient('b')];
  const worker = dispatcher(delivery, { clock: () => now,
    resolveRecipients: async () => targets,
    revalidateRecipient: async old => linked || old.id === 'a' ? targets.find(row => row.id === old.id) : null,
    transports: { telegram: { send: async ({ recipient: current }) => {
      attempts.push(current.id); return { state: current.id === 'a' ? 'sent' : 'retry' };
    } } }
  });
  await worker.runOnce();
  assert.deepEqual(attempts.sort(), ['a', 'b']);
  linked = false; now = 1001;
  await worker.runOnce();
  assert.equal(attempts.length, 2);
  assert.deepEqual(rows(store).map(row => row.state).sort(), ['sent', 'skipped']);
});

test('crash before send permits recovery; old leases cannot authorize a send or acknowledge it', async t => {
  const { service, delivery, store } = setup(t);
  create(service);
  const plan = delivery.claimPlan(1, 10, 3);
  delivery.finishPlan(plan, [snapshot(recipient())], 1);
  const old = delivery.claimDelivery(1, 10), next = delivery.claimDelivery(12, 10);
  assert.equal(delivery.beginSend(old, 12), false);
  assert.equal(delivery.finish(old, 12, 'sent', 'accepted'), false);
  assert.equal(delivery.beginSend(next, 12), true);
  assert.equal(delivery.finish(next, 12, 'sent', 'accepted'), true);
  assert.equal(rows(store)[0].state, 'sent');
});

test('never-resolving transport times out to unknown; background lifecycle stops without losing queued work', async t => {
  const { service, delivery, store } = setup(t);
  create(service);
  const worker = dispatcher(delivery, { policy: { sendTimeoutMs: 15, leaseMs: 1000, intervalMs: 10 },
    transports: { telegram: { send: () => new Promise(() => {}) } } });
  worker.start();
  await new Promise(resolve => setTimeout(resolve, 40));
  await worker.stop();
  assert.equal(rows(store)[0].state, 'unknown');
  assert.equal(worker.status().running, false);
  assert.equal(service.list(user).items.length, 1);
});

test('product receiver may retry only an explicit rejection; opaque 5xx is unknown and 403 is permanent', async t => {
  let mode = 'retry';
  const base = await receiver(t, (_req, res) => {
    if (mode === 'retry') reply(res, 503, { accepted: false, retryable: true, retryAfterMs: 5000 });
    else if (mode === 'unknown') reply(res, 500, { error: 'uncertain' });
    else reply(res, 403, { accepted: false });
  });
  const transport = createProductTransport({ url: base, token: 'test-token' });
  const input = { recipient: recipient(), notification: { id: 'stable-id' }, signal: AbortSignal.timeout(1000) };
  assert.deepEqual(await transport.send(input), { state: 'retry', retryAfterMs: 5000 });
  mode = 'unknown'; assert.equal((await transport.send(input)).state, 'unknown');
  mode = 'failed'; assert.equal((await transport.send(input)).state, 'failed');
});

test('runtime loads a host adapter module, runs the worker and shuts down cleanly', async t => {
  const dir = temporary(), { service, store } = setup(t);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'adapter.mjs');
  writeFileSync(file, `export function createDeliveryAdapters() { return {
    resolveRecipients: async () => [${JSON.stringify(recipient())}],
    revalidateRecipient: async r => ({...r,enabled:true,address:'12345'}),
    transports: {telegram: {send: async () => ({state:'sent'})}}
  }; }`);
  create(service);
  const worker = await startConfiguredDelivery({ config: { delivery: { enabled: true, adapterModule: file } }, store, service });
  assert.ok(worker);
  await worker.runOnce();
  await worker.stop();
  assert.equal(rows(store)[0].state, 'sent');
});

test('untrusted Telegram transport never reaches account lookup or persistence', async t => {
  const { service, store } = setup(t);
  let lookups = 0;
  const ingress = createSupportIngress({ service, store, telegramSource: 'bot',
    authenticateTelegram: async request => request?.verified === true,
    resolveTelegram: async () => { lookups++; return null; } });
  await assert.rejects(ingress.fromTelegram({ update_id: 1 }, { verified: false }), error => error.code === 'telegram_transport_unauthorized');
  assert.equal(lookups, 0);
  assert.equal(service.list(user).items.length, 0);
});

test('recipient lookup timeout retries without sending; empty recipients do not become delivered', async t => {
  const { service, store, delivery } = setup(t);
  create(service);
  let now = 1, lookups = 0;
  const worker = dispatcher(delivery, { clock: () => now, policy: { maxAttempts: 2, baseDelayMs: 10, sendTimeoutMs: 5 },
    resolveRecipients: () => { lookups++; return new Promise(() => {}); } });
  await worker.runOnce();
  assert.equal(worker.status().intents.pending, 1);
  now = 11; await worker.runOnce(); now = 100; await worker.runOnce();
  assert.equal(lookups, 2);
  assert.equal(worker.status().intents.failed, 1);
  assert.equal(rows(store).length, 0);
  service.create(user, { subject: 'Без получателей', body: 'Сохранить' }, 'empty-recipients-01');
  await dispatcher(delivery, { resolveRecipients: async () => [] }).runOnce();
  assert.equal(worker.status().intents.sent ?? 0, 0);
  assert.equal(service.list(user).items.length, 2);
});

test('Telegram update receipt survives restart and cannot switch ticket after the lost response', async t => {
  const dir = temporary(), filename = join(dir, 'state.sqlite');
  let store = new SqliteStore(filename);
  const binding = { principal: user, enabled: true, binding: 'rev-1',
    support: { active: true, action: 'create', subject: 'Потерялся ответ' } };
  const make = () => createSupportIngress({ service: new SupportService(store), store,
    authenticateTelegram: async () => true, resolveTelegram: async () => binding, telegramSource: 'media' });
  const update = { update_id: 700, message: { from: { id: 1 }, chat: { type: 'private', id: 1 }, text: 'Принять один раз' } };
  const accepted = await make().fromTelegram(update);
  store.close(); store = new SqliteStore(filename);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  binding.support = { active: false };
  const repeated = await make().fromTelegram(update);
  assert.equal(repeated.id, accepted.id);
  assert.equal(repeated.replayed, true);
  assert.equal(new SupportService(store).messages(user, accepted.id).items.length, 1);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM notification_intents').get().n, 1);
});

test('actual CLI: authenticated product HTTP message is persisted and delivered by configured background runtime', async t => {
  const dir = temporary(), received = [];
  const target = await receiver(t, (_req, res, value) => { received.push(value); reply(res, 200, { accepted: true }); });
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const token = 'synthetic-user-key-for-local-test';
  const identitiesFile = join(dir, 'identities.json'), adapterModule = join(dir, 'adapters.mjs');
  writeFileSync(identitiesFile, JSON.stringify([{ ...user, tokenHash: createHash('sha256').update(token).digest('hex') }]));
  writeFileSync(adapterModule, `import {createProductTransport} from ${JSON.stringify(new URL('../src/index.mjs', import.meta.url).href)};
    export function createDeliveryAdapters() { return {
      resolveRecipients: async () => [${JSON.stringify(recipient('cli-operator', 'product'))}],
      revalidateRecipient: async r => ({...r,enabled:true}),
      transports: {product:createProductTransport({url:${JSON.stringify(target)},token:'synthetic-receiver-key'})}
    }; }`);
  const configFile = join(dir, 'runtime.json');
  writeFileSync(configFile, JSON.stringify({ host: '127.0.0.1', port, dataDirectory: join(dir, 'data'), identitiesFile,
    requestBytes: 65536, requestsPerMinute: 180,
    delivery: { enabled: true, adapterModule, policy: { intervalMs: 10 } } }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, SUPPORT_CONFIG: configFile },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { output += value; });
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    rmSync(dir, { recursive: true, force: true });
  });
  async function until(condition) {
    const deadline = Date.now() + 3000;
    while (!await condition()) {
      if (Date.now() > deadline || child.exitCode !== null) assert.fail(`CLI scenario failed: ${output}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  await until(() => output.includes('Support listening'));
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  await until(async () => (await (await fetch(`http://127.0.0.1:${port}/api/v1/session`, { headers })).json()).capabilities.externalDelivery);
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/tickets`, {
    method: 'POST', headers: { ...headers, 'idempotency-key': 'cli-create-event' },
    body: JSON.stringify({ subject: 'Из веб-сервиса', body: 'Сохранить и доставить 🦊' })
  });
  assert.equal(response.status, 201);
  const receipt = await response.json();
  await until(() => received.length === 1);
  assert.equal(received[0].notification.ticketId, receipt.id);
  assert.equal(received[0].notification.body, 'Сохранить и доставить 🦊');
  assert.ok(!output.includes(token));
  assert.ok(!output.includes('Сохранить и доставить'));
});
