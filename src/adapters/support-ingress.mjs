import { createHash } from 'node:crypto';
import { identity, requireThat } from '../core/domain.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Reuses the core's transactions/permissions/idempotency; no account IDs are trusted from request bodies. */
export function createSupportIngress({ service, store, authenticateProduct, authenticateTelegram, resolveTelegram, telegramSource }) {
  if (store !== service.store) throw new Error('ingress_store_mismatch');

  function accept(principal, command, key) {
    const p = identity(principal);
    requireThat(p.role === 'user', 'user_required', 403);
    requireThat(command && typeof command === 'object', 'invalid_command');
    if (command.action === 'create') return service.create(p, { subject: command.subject, body: command.body }, key);
    requireThat(command.action === 'reply', 'invalid_command');
    return service.change(p, command.ticketId, { type: 'message', body: command.body, version: command.version }, key);
  }

  return {
    async fromProduct(request, command, idempotencyKey) {
      requireThat(typeof authenticateProduct === 'function', 'product_adapter_disabled', 503);
      return accept(await authenticateProduct(request), command, idempotencyKey);
    },

    async fromTelegram(update, request) {
      requireThat(store.deliveryReady(), 'delivery_schema_required', 503);
      requireThat(typeof authenticateTelegram === 'function' && await authenticateTelegram(request) === true,
        'telegram_transport_unauthorized', 401);
      requireThat(typeof resolveTelegram === 'function' && typeof telegramSource === 'string' &&
        /^[A-Za-z0-9_-]{1,100}$/.test(telegramSource), 'telegram_adapter_disabled', 503);
      requireThat(Number.isSafeInteger(update?.update_id) && update.update_id >= 0, 'invalid_update');
      const message = update.message;
      requireThat(message?.chat?.type === 'private' && !message.from?.is_bot &&
        Number.isSafeInteger(message.from?.id) && message.from.id === message.chat.id, 'private_chat_required', 403);
      requireThat(typeof message.text === 'string' && message.text.trim().length > 0, 'text_required');
      // The host validates account/link/opt-in and persists the explicitly selected support context.
      const binding = await resolveTelegram({ userId: String(message.from.id), chatId: String(message.chat.id) });
      requireThat(binding?.enabled === true && typeof binding.binding === 'string' && binding.binding.length > 0,
        'telegram_binding_required', 403);
      const p = identity(binding.principal);
      requireThat(p.role === 'user', 'user_required', 403);
      const source = `telegram:${telegramSource}`, eventId = String(update.update_id);
      const fingerprint = digest({ principal: p, binding: binding.binding, text: message.text, from: message.from.id, chat: message.chat.id });
      return store.transaction(() => {
        const previous = store.inboundReceipt(source, eventId);
        if (previous) {
          requireThat(previous.fingerprint === fingerprint, 'idempotency_conflict', 409);
          const receipt = JSON.parse(previous.receipt);
          service.get(p, receipt.id); // Recheck current access even when returning a receipt.
          return { ...receipt, replayed: true };
        }
        requireThat(binding.support?.active === true, 'support_mode_required', 409);
        const command = { ...binding.support, body: message.text };
        const receipt = accept(p, command, digest({ source, eventId }));
        store.rememberInbound(source, eventId, fingerprint, receipt);
        return receipt;
      });
    }
  };
}
