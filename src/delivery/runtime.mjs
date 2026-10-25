import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NotificationDispatcher } from './dispatcher.mjs';
import { SqliteDeliveryStore } from '../storage/delivery-store.mjs';

/** Optional capability. A missing/invalid adapter disables delivery, never ticket persistence. */
export async function startConfiguredDelivery({ config, store, service, report = () => {} }) {
  if (config.delivery?.enabled !== true) return null;
  try {
    if (typeof config.delivery.adapterModule !== 'string' || !config.delivery.adapterModule.trim())
      throw new Error('adapter_module_required');
    const module = await import(pathToFileURL(resolve(config.delivery.adapterModule)).href);
    const adapters = await module.createDeliveryAdapters({ service });
    const worker = new NotificationDispatcher({ ...adapters, store: new SqliteDeliveryStore(store), policy: config.delivery.policy });
    worker.start();
    return worker;
  } catch {
    report('delivery_disabled');
    return null;
  }
}
