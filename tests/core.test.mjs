import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SqliteStore, SupportService } from '../src/index.mjs';

const user = { tenant: 'product-a', subject: 'user-a', role: 'user' };
const other = { ...user, subject: 'user-b' };
const operator = { ...user, subject: 'operator-a', role: 'operator' };
const foreign = { ...operator, tenant: 'product-b' };
const key = number => `operation_${number}`;

function setup(t, options) {
  const store = new SqliteStore(':memory:');
  t.after(() => store.close());
  return { store, service: new SupportService(store, options) };
}
function create(service, who = user, suffix = 1) {
  return service.create(who, { subject: 'Не проходит оплата', body: 'Пожалуйста, помогите разобраться.' }, key(suffix));
}
function change(service, id, version, input, suffix, who = operator) {
  return service.change(who, id, { version, ...input }, key(suffix));
}
function code(expected) { return error => error.code === expected; }
function count(store, table) { return store.db.prepare(`SELECT count(*) AS total FROM ${table}`).get().total; }

test('creation atomically saves ticket, public message, audit, notification intent and receipt', t => {
  const { service, store } = setup(t);
  const receipt = create(service);
  assert.equal(receipt.version, 1);
  assert.equal(service.get(user, receipt.id).owner, user.subject);
  assert.equal(service.messages(user, receipt.id).items[0].body, 'Пожалуйста, помогите разобраться.');
  for (const table of ['tickets', 'messages', 'audit', 'notification_intents', 'idempotency']) assert.equal(count(store, table), 1);
});

test('lost response replay returns original receipt and does not repeat side effects', t => {
  const { service, store } = setup(t);
  const first = create(service);
  const repeated = create(service);
  assert.deepEqual(repeated, { ...first, replayed: true });
  assert.equal(count(store, 'tickets'), 1);
  assert.equal(count(store, 'notification_intents'), 1);
  assert.throws(() => service.create(user, { subject: 'Другой текст', body: 'Другой вопрос' }, key(1)), code('idempotency_conflict'));
});

test('idempotency is scoped by tenant, actor and operation', t => {
  const { service } = setup(t);
  const first = create(service);
  const second = create(service, other);
  const third = create(service, { ...user, tenant: 'product-b' });
  assert.equal(new Set([first.id, second.id, third.id]).size, 3);
  assert.equal(change(service, first.id, 1, { type: 'message', body: 'Ответ' }, 1).version, 2);
});

test('owner and tenant isolation applies to list, get, history, writes and audit', t => {
  const { service } = setup(t);
  const { id } = create(service);
  for (const who of [other, foreign]) {
    assert.deepEqual(service.list(who).items, []);
    assert.throws(() => service.get(who, id), code('not_found'));
    assert.throws(() => service.messages(who, id), code('not_found'));
    assert.throws(() => change(service, id, 1, { type: 'message', body: 'Чужой ответ' }, 2, who), code('not_found'));
  }
  assert.throws(() => service.audit(user, id), code('forbidden'));
  assert.throws(() => service.audit(foreign, id), code('not_found'));
  assert.equal(service.list(operator).items.length, 1);
});

test('internal notes are invisible to user history and never enter notification intents', t => {
  const { service, store } = setup(t);
  const { id } = create(service);
  change(service, id, 1, { type: 'message', body: 'Внутренняя информация', visibility: 'internal' }, 2);
  assert.equal(service.messages(user, id).items.length, 1);
  assert.equal(service.messages(operator, id).items.length, 2);
  assert.equal(count(store, 'notification_intents'), 1);
  assert.throws(() => change(service, id, 2, { type: 'message', body: 'Заметка', visibility: 'internal' }, 3, user), code('forbidden'));
});

test('public response, status, assignment and automatic reopen preserve audit and versions', t => {
  const { service, store } = setup(t);
  const { id } = create(service);
  change(service, id, 1, { type: 'assignment', assigned: true }, 2);
  assert.equal(service.get(operator, id).assignee, operator.subject);
  change(service, id, 2, { type: 'status', status: 'in_progress' }, 3);
  change(service, id, 3, { type: 'message', body: 'Уточните детали' }, 4);
  change(service, id, 4, { type: 'status', status: 'waiting_user' }, 5);
  change(service, id, 5, { type: 'message', body: 'Вот детали' }, 6, user);
  assert.equal(service.get(user, id).status, 'in_progress');
  change(service, id, 6, { type: 'status', status: 'resolved' }, 7);
  const reply = { type: 'message', version: 7, body: 'Проблема повторилась' };
  const first = service.change(user, id, reply, key(8));
  assert.equal(service.get(user, id).status, 'in_progress');
  assert.deepEqual(service.change(user, id, reply, key(8)), { ...first, replayed: true });
  assert.equal(service.audit(operator, id).items[0].details.from, 'resolved');
  assert.equal(count(store, 'notification_intents'), 4);
});

test('stale concurrent writer has no message, audit, outbox or idempotency side effects', t => {
  const { service, store } = setup(t);
  const { id } = create(service);
  change(service, id, 1, { type: 'assignment', assigned: true }, 2);
  assert.throws(() => change(service, id, 1, { type: 'message', body: 'Устаревший ответ' }, 3), code('version_conflict'));
  assert.equal(count(store, 'messages'), 1);
  assert.equal(count(store, 'audit'), 2);
  assert.equal(count(store, 'notification_intents'), 1);
  assert.equal(count(store, 'idempotency'), 2);
});

test('transaction rolls back every record on persistence failure and permits safe retry', t => {
  const { service, store } = setup(t);
  const enqueue = store.enqueue;
  store.enqueue = () => { throw new Error('Injected storage failure'); };
  assert.throws(() => create(service), /Injected storage failure/);
  for (const table of ['tickets', 'messages', 'audit', 'notification_intents', 'idempotency']) assert.equal(count(store, table), 0);
  store.enqueue = enqueue;
  assert.equal(create(service).version, 1);
});

test('records and replay receipts survive database close/reopen', t => {
  const directory = mkdtempSync(join(tmpdir(), 'support-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'support.sqlite');
  const firstStore = new SqliteStore(filename);
  const first = create(new SupportService(firstStore));
  firstStore.close();
  const secondStore = new SqliteStore(filename);
  try {
    const service = new SupportService(secondStore);
    assert.equal(service.messages(user, first.id).items.length, 1);
    assert.equal(create(service).replayed, true);
    assert.equal(count(secondStore, 'notification_intents'), 1);
  } finally { secondStore.close(); }
});

test('durable write rate limit does not charge replay and resets by injected time', t => {
  let now = 100000;
  const { service } = setup(t, { policy: { writesPerMinute: 1 }, clock: () => now });
  create(service);
  assert.equal(create(service).replayed, true);
  assert.throws(() => create(service, user, 2), code('rate_limited'));
  now += 60001;
  assert.equal(create(service, user, 2).version, 1);
});

test('committed receipt and message survive writer process exit without closing SQLite', t => {
  const directory = mkdtempSync(join(tmpdir(), 'support-restart-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = join(directory, 'support.sqlite');
  const moduleUrl = new URL('../src/index.mjs', import.meta.url).href;
  const program = `import {SqliteStore,SupportService} from ${JSON.stringify(moduleUrl)};
    const service=new SupportService(new SqliteStore(process.argv[1]));
    const receipt=service.create({tenant:'product-a',subject:'user-a',role:'user'},
      {subject:'После перезапуска',body:'Сохранённый текст'},'restart-key');
    process.stdout.write(JSON.stringify(receipt),()=>process.exit(0));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program, filename], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
  const receipt = JSON.parse(child.stdout);
  const store = new SqliteStore(filename);
  try {
    const service = new SupportService(store);
    assert.equal(service.messages(user, receipt.id).items[0].body, 'Сохранённый текст');
    const replay = service.create(user, { subject: 'После перезапуска', body: 'Сохранённый текст' }, 'restart-key');
    assert.equal(replay.id, receipt.id);
    assert.equal(replay.replayed, true);
  } finally { store.close(); }
});

test('stable cursor pagination scopes users and excludes internal notes before applying limit', t => {
  const { service } = setup(t);
  const a = create(service), b = create(service, user, 2);
  create(service, other, 3);
  const first = service.list(user, { limit: 1 });
  assert.equal(first.items[0].id, b.id);
  const second = service.list(user, { before: first.nextCursor, limit: 1 });
  assert.equal(second.items[0].id, a.id);
  assert.equal(second.nextCursor, null);
  change(service, a.id, 1, { type: 'message', body: 'Заметка', visibility: 'internal' }, 4);
  change(service, a.id, 2, { type: 'message', body: 'Публичный ответ' }, 5);
  const history = service.messages(user, a.id, { limit: 1 });
  assert.equal(history.items[0].body, 'Публичный ответ');
  const older = service.messages(user, a.id, { before: history.nextCursor, limit: 1 });
  assert.equal(older.items[0].author_role, 'user');
  assert.equal(older.nextCursor, null);
});

test('validation, transitions and permissions reject invalid commands without mutation', t => {
  const { service, store } = setup(t);
  assert.throws(() => create(service, null), code('unauthorized'));
  assert.throws(() => create(service, operator), code('user_required'));
  assert.throws(() => service.create(user, { subject: ' ', body: 'Text' }, key(1)), code('invalid_subject'));
  assert.throws(() => service.create(user, { subject: 'Text', body: 'Text' }, ''), code('idempotency_key_required'));
  const { id } = create(service);
  assert.throws(() => change(service, id, 1, { type: 'status', status: 'waiting_user' }, 2), code('invalid_transition'));
  assert.throws(() => change(service, id, 1, { type: 'status', status: 'resolved' }, 2, user), code('forbidden'));
  assert.throws(() => change(service, id, undefined, { type: 'message', body: 'Ответ' }, 2), code('version_required'));
  for (const options of [{ limit: 0 }, { limit: 101 }, { before: -1 }, { before: 1.2 }]) assert.throws(() => service.list(user, options));
  assert.equal(count(store, 'messages'), 1);
  assert.equal(service.get(user, id).version, 1);
});
