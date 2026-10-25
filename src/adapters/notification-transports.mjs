function endpoint(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))
    throw new Error('invalid_delivery_endpoint');
  return url;
}

async function json(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('empty_response');
  const chunks = [];
  let length = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    length += part.value.length;
    if (length > 65536) { await reader.cancel(); throw new Error('response_too_large'); }
    chunks.push(part.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Telegram destination comes only from a live host binding, never the inbound body. */
export function createTelegramTransport({ token, baseUrl = 'https://api.telegram.org', fetchImpl = fetch }) {
  if (typeof token !== 'string' || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('telegram_token_required');
  const base = endpoint(baseUrl);
  return {
    async send({ recipient, notification, signal }) {
      if (!/^-?\d{1,20}$/.test(String(recipient.address ?? ''))) return { state: 'failed' };
      try {
        const fullText = `Поддержка · ${notification.ticketId}\n${notification.subject}\n\n${notification.body}`;
        const preview = fullText.length <= 4000 ? fullText :
          `${fullText.slice(0, 3950).replace(/[\uD800-\uDBFF]$/, '')}\n…Полный текст — в обращении.`;
        const response = await fetchImpl(new URL(`${base.pathname.replace(/\/$/, '')}/bot${token}/sendMessage`, base), {
          method: 'POST', redirect: 'error', signal,
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ chat_id: String(recipient.address), text: preview })
        });
        const payload = await json(response);
        if (response.ok && payload.ok === true && payload.result?.message_id != null) return { state: 'sent' };
        if (payload.ok === false && (response.status === 429 || payload.error_code === 429)) {
          const seconds = payload.parameters?.retry_after;
          return { state: 'retry', retryAfterMs: Number.isSafeInteger(seconds) && seconds > 0 ? Math.min(seconds, 86400) * 1000 : 1000 };
        }
        if (payload.ok === false && [400, 401, 403, 404].includes(payload.error_code ?? response.status)) return { state: 'failed' };
        return { state: 'unknown' };
      } catch { return { state: 'unknown' }; }
    }
  };
}

/** Host-owned authenticated notification receiver; this is not an ai-media-client route yet. */
export function createProductTransport({ url, token, fetchImpl = fetch }) {
  const target = endpoint(url);
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new Error('product_token_required');
  return {
    async send({ recipient, notification, signal }) {
      try {
        const response = await fetchImpl(target, {
          method: 'POST', redirect: 'error', signal,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8', 'idempotency-key': notification.id },
          body: JSON.stringify({ notification, recipient: { id: recipient.id, subject: recipient.principal.subject, binding: recipient.binding } })
        });
        const payload = await json(response);
        if (response.ok && payload.accepted === true) return { state: 'sent' };
        // A retry is safe only when the receiver explicitly confirms it did NOT accept the message.
        if (payload.accepted === false && payload.retryable === true && [429, 503].includes(response.status)) {
          return { state: 'retry', retryAfterMs: payload.retryAfterMs };
        }
        if (payload.accepted === false && [400, 401, 403, 404, 413, 422].includes(response.status)) return { state: 'failed' };
        return { state: 'unknown' };
      } catch { return { state: 'unknown' }; }
    }
  };
}
