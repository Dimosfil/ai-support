import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { localIdentityAdapter } from '../src/adapters/local-identity.mjs';

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'support-config-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test('config resolves I/O paths and rejects public listeners or invalid required settings', t => {
  const folder = directory(t), filename = join(folder, 'config.json');
  const config = { host: '127.0.0.1', port: 4317, dataDirectory: join(folder, 'data'), identitiesFile: join(folder, 'identities.json'), requestBytes: 65536, requestsPerMinute: 180 };
  writeFileSync(filename, JSON.stringify(config));
  const loaded = loadConfig(filename);
  assert.equal(loaded.dataDirectory, resolve(config.dataDirectory));
  assert.ok(existsSync(loaded.dataDirectory));
  for (const invalid of [{ host: '0.0.0.0' }, { port: 0 }, { dataDirectory: '' }, { requestBytes: -1 }, { requestsPerMinute: '180' }]) {
    writeFileSync(filename, JSON.stringify({ ...config, ...invalid }));
    assert.throws(() => loadConfig(filename));
  }
});

test('local setup generates separate credentials, logs no keys and refuses overwrite', t => {
  const folder = directory(t);
  mkdirSync(join(folder, 'config'));
  writeFileSync(join(folder, 'config/support.example.json'), readFileSync(new URL('../config/support.example.json', import.meta.url)));
  const script = new URL('../scripts/setup-local.mjs', import.meta.url);
  const run = () => spawnSync(process.execPath, [fileURLToPath(script)], { cwd: folder, encoding: 'utf8', timeout: 10000 });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const access = readFileSync(join(folder, '.local/access.txt'), 'utf8');
  const tokens = access.trim().split('\n').map(line => line.trim().split(': ')[1]);
  assert.equal(tokens.length, 2);
  assert.notEqual(tokens[0], tokens[1]);
  const auth = localIdentityAdapter(join(folder, '.local/identities.json'));
  for (let i = 0; i < tokens.length; i++) {
    assert.equal(auth({ headers: { authorization: `Bearer ${tokens[i]}` } }).role, ['user', 'operator'][i]);
    assert.ok(!result.stdout.includes(tokens[i]));
    assert.ok(!readFileSync(join(folder, '.local/identities.json'), 'utf8').includes(tokens[i]));
  }
  assert.equal(run().status, 1);
  assert.equal(readFileSync(join(folder, '.local/access.txt'), 'utf8'), access);
});
