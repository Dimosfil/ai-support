// Copy to .local/delivery-adapters.mjs and supply host-owned identity/routing.
// This example intentionally has no configured recipients or real sends.
import { createTelegramTransport, createProductTransport } from '../src/adapters/notification-transports.mjs';

export async function createDeliveryAdapters() {
  const transports = {};
  if (process.env.SUPPORT_TELEGRAM_BOT_TOKEN)
    transports.telegram = createTelegramTransport({ token: process.env.SUPPORT_TELEGRAM_BOT_TOKEN });
  if (process.env.SUPPORT_PRODUCT_NOTIFICATION_URL && process.env.SUPPORT_PRODUCT_NOTIFICATION_TOKEN)
    transports.product = createProductTransport({ url: process.env.SUPPORT_PRODUCT_NOTIFICATION_URL,
      token: process.env.SUPPORT_PRODUCT_NOTIFICATION_TOKEN });
  return {
    transports,
    // Throw while routing is unconfigured: intents remain pending for bounded retries.
    async resolveRecipients() { throw new Error('host_recipient_directory_required'); },
    async revalidateRecipient() { return null; }
  };
}
