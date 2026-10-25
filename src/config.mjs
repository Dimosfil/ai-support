import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { requireThat } from './core/domain.mjs';

/** All relative configuration paths are resolved against the project working directory. */
export function loadConfig(filename = process.env.SUPPORT_CONFIG ?? '.local/runtime.json') {
  const config = JSON.parse(readFileSync(resolve(filename), 'utf8'));
  requireThat(['127.0.0.1', '::1'].includes(config.host), 'local_adapter_requires_loopback');
  requireThat(Number.isInteger(config.port) && config.port > 0 && config.port <= 65535, 'invalid_port');
  for (const key of ['requestBytes', 'requestsPerMinute'])
    requireThat(Number.isSafeInteger(config[key]) && config[key] > 0, `invalid_${key}`);
  for (const key of ['dataDirectory', 'identitiesFile'])
    requireThat(typeof config[key] === 'string' && config[key].trim().length > 0, `invalid_${key}`);
  config.dataDirectory = resolve(config.dataDirectory);
  config.identitiesFile = resolve(config.identitiesFile);
  mkdirSync(config.dataDirectory, { recursive: true });
  return config;
}
