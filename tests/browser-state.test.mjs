import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareWrite } from '../src/web/retry.js';

test('uncertain browser message retains original key and version after history refresh', () => {
  const first = prepareWrite(null, { type: 'message', version: 2, body: 'Ответ', visibility: 'public' }, () => 'original-key');
  const retry = prepareWrite(first.pending, { type: 'message', version: 3, body: 'Ответ', visibility: 'public' }, () => { throw new Error('Must not generate another key'); });
  assert.equal(retry.pending.key, 'original-key');
  assert.equal(JSON.parse(retry.pending.payload).version, 2);
  assert.equal(retry.recoveryOnly, false);
});

test('edited browser draft cannot overwrite an uncertain write before recovery', () => {
  const first = prepareWrite(null, { subject: 'Тема', body: 'Первое обращение' }, () => 'original-key');
  const next = prepareWrite(first.pending, { subject: 'Тема', body: 'Изменённое обращение' }, () => 'new-key');
  assert.equal(next.recoveryOnly, true);
  assert.deepEqual(next.pending, first.pending);
});
