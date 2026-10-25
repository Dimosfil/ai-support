import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// Explicit local setup. Never overwrite existing credentials or runtime settings.
const paths = ['.local/runtime.json', '.local/identities.json', '.local/access.txt'];
if (paths.some(path => existsSync(path))) {
  console.error('Local setup already exists. Preserve it; configure existing files manually.');
  process.exitCode = 1;
} else {
  mkdirSync('.local', { recursive: true, mode: 0o700 });
  const records = [], access = [];
  for (const role of ['user', 'operator']) {
    const token = randomBytes(32).toString('base64url');
    records.push({ tenant: 'local-product', subject: `local-${role}`, role,
      tokenHash: createHash('sha256').update(token).digest('hex') });
    access.push(`${role}: ${token}`);
  }
  writeFileSync(paths[0], readFileSync('config/support.example.json'), { flag: 'wx', mode: 0o600 });
  writeFileSync(paths[1], JSON.stringify(records, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  writeFileSync(paths[2], access.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  console.log('Local setup created. Credentials: .local/access.txt (keep private). Runtime: .local/runtime.json.');
}
