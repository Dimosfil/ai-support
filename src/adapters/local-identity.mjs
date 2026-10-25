import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { identity, requireThat } from '../core/domain.mjs';

/** Development adapter only. The product host replaces this with its own session verifier. */
export function localIdentityAdapter(filename) {
  const records = JSON.parse(readFileSync(filename, 'utf8'));
  requireThat(Array.isArray(records) && records.length > 0, 'invalid_identity_configuration');
  const identities = new Map();
  for (const record of records) {
    requireThat(typeof record.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(record.tokenHash), 'invalid_token_hash');
    requireThat(!identities.has(record.tokenHash), 'duplicate_token_hash');
    identities.set(record.tokenHash, identity(record));
  }
  return request => {
    const header = request.headers.authorization;
    requireThat(typeof header === 'string' && /^Bearer [A-Za-z0-9_-]{32,128}$/.test(header), 'unauthorized', 401);
    const hash = createHash('sha256').update(header.slice(7)).digest('hex');
    const principal = identities.get(hash);
    requireThat(principal, 'unauthorized', 401);
    return principal;
  };
}
