import { join } from 'node:path';
import { loadConfig } from './config.mjs';
import { SqliteStore, SupportService } from './index.mjs';
import { localIdentityAdapter } from './adapters/local-identity.mjs';
import { createHttpServer } from './http/app.mjs';
import { startConfiguredDelivery } from './delivery/runtime.mjs';

let store, delivery;
try {
  const config = loadConfig();
  const authenticate = localIdentityAdapter(config.identitiesFile);
  store = new SqliteStore(join(config.dataDirectory, 'support.sqlite'));
  const service = new SupportService(store, { policy: config.policy });
  const server = createHttpServer({ ...config, service, authenticate, getDeliveryStatus: () => delivery?.status() });
  // Never log request headers, message bodies, credentials or raw DB errors.
  server.on('applicationError', () => console.error('Support request failed; response: service_unavailable'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => { server.removeListener('error', reject); resolve(); });
  });
  console.log(`Support listening on http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}`);
  delivery = await startConfiguredDelivery({ config, store, service,
    report: () => console.error('Support notification delivery disabled; check adapter configuration and schema v2.') });
  server.on('error', async error => {
    console.error(`Support listener failed (${error.code ?? 'unknown'}). Check the configured address.`);
    await delivery?.stop();
    store.close();
    process.exitCode = 1;
  });
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    if (closing) return;
    closing = true;
    server.close(async () => { await delivery?.stop(); store.close(); });
    server.closeIdleConnections();
  });
} catch {
  store?.close();
  console.error('Support startup failed. Check SUPPORT_CONFIG, local identity file, database permissions and policy. See docs/LOCAL_RUN.md.');
  process.exitCode = 1;
}
