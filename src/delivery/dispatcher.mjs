import { setTimeout as sleep } from 'node:timers/promises';
import { identity } from '../core/domain.mjs';

const defaults = Object.freeze({ maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 60000,
  leaseMs: 30000, sendTimeoutMs: 10000, intervalMs: 1000, batchSize: 20 });
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 128;

async function bounded(operation, milliseconds) {
  const timer = new AbortController();
  try {
    return await Promise.race([Promise.resolve().then(operation), sleep(milliseconds, undefined, { signal: timer.signal })
      .then(() => { throw new Error('adapter_timeout'); })]);
  } finally { timer.abort(); }
}

export function recipientSnapshot(value) {
  if (!value || !validId(value.id) || !validId(value.channel) || !validId(value.binding))
    throw new Error('invalid_recipient');
  const principal = identity(value.principal);
  // Only stable routing identity is persisted. Never persist credentials/endpoints.
  return { id: value.id, channel: value.channel, binding: value.binding,
    principal: { tenant: principal.tenant, subject: principal.subject, role: principal.role } };
}

function allowed(context, recipient) {
  const p = recipient.principal;
  return p.tenant === context.tenant && (context.audience === 'operators'
    ? p.role === 'operator' : p.role === 'user' && p.subject === context.owner);
}

/** Resolving identity/routing belongs to the host product; sending belongs to transports. */
export class NotificationDispatcher {
  #running = null;
  #loop = null;
  #abort = null;
  constructor({ store, resolveRecipients, revalidateRecipient, transports, clock = Date.now, policy = {} }) {
    if (typeof resolveRecipients !== 'function' || typeof revalidateRecipient !== 'function' || !transports)
      throw new Error('delivery_adapters_required');
    if (Object.keys(transports).length === 0 || Object.values(transports).some(value => typeof value?.send !== 'function'))
      throw new Error('delivery_transport_required');
    this.store = store;
    this.resolveRecipients = resolveRecipients;
    this.revalidateRecipient = revalidateRecipient;
    this.transports = transports;
    this.clock = clock;
    this.policy = { ...defaults, ...policy };
    for (const value of Object.values(this.policy))
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid_delivery_policy');
    if (this.policy.sendTimeoutMs >= this.policy.leaseMs || this.policy.batchSize > 100)
      throw new Error('invalid_delivery_policy');
    this.activity = { running: false, lastStartedAt: null, lastFinishedAt: null, lastError: null };
  }

  #delay(attempt, retryAfterMs = 0) {
    return Math.max(Math.min(retryAfterMs, 86400000), Math.min(this.policy.maxDelayMs,
      this.policy.baseDelayMs * 2 ** Math.min(attempt - 1, 20)));
  }

  async #plan() {
    const plan = this.store.claimPlan(this.clock(), this.policy.leaseMs, this.policy.maxAttempts);
    if (!plan) return false;
    if (plan.exhausted) return true;
    try {
      const context = this.store.context(plan.seq);
      if (!context) throw new Error('public_message_required');
      const rows = await bounded(() => this.resolveRecipients({ tenant: context.tenant, ticketId: context.ticket_id,
        owner: context.owner, audience: context.audience }), this.policy.sendTimeoutMs);
      if (!Array.isArray(rows) || rows.length > 100) throw new Error('invalid_recipients');
      const recipients = rows.map(recipientSnapshot);
      if (new Set(recipients.map(row => row.id)).size !== recipients.length || recipients.some(row => !allowed(context, row)))
        throw new Error('invalid_recipients');
      this.store.finishPlan(plan, recipients, this.clock());
    } catch {
      this.store.failPlan(plan, this.clock(), this.#delay(plan.attempts), 'resolution_failed', plan.attempts >= this.policy.maxAttempts);
    }
    return true;
  }

  async #deliver() {
    const job = this.store.claimDelivery(this.clock(), this.policy.leaseMs);
    if (!job) return false;
    const finish = (state, code, delay) => this.store.finish(job, this.clock(), state, code, delay);
    if (job.attempts > this.policy.maxAttempts) {
      finish('failed', 'attempts_exhausted');
      return true;
    }
    let current, sending = false;
    try {
      // The callback must consult live sessions/roles/link/opt-in before each attempt.
      current = await bounded(() => this.revalidateRecipient(job.recipient, { tenant: job.recipient.principal.tenant,
        ticketId: this.store.context(job.intent_seq)?.ticket_id }), this.policy.sendTimeoutMs);
      const context = this.store.context(job.intent_seq);
      if (!current || current.enabled !== true || !context || !allowed(context, recipientSnapshot(current)) ||
          JSON.stringify(recipientSnapshot(current)) !== JSON.stringify(job.recipient)) {
        finish('skipped', 'recipient_revoked');
        return true;
      }
      const transport = this.transports[current.channel];
      if (!transport || typeof transport.send !== 'function') throw new Error('transport_unavailable');
      if (!this.store.beginSend(job, this.clock())) return true;
      sending = true;
      let outcome;
      try {
        const notification = { id: job.id, tenant: context.tenant, ticketId: context.ticket_id,
          messageId: context.message_id, subject: context.subject, body: context.body, audience: context.audience };
        const signal = AbortSignal.timeout(this.policy.sendTimeoutMs);
        // A timeout races even a custom transport that ignores AbortSignal. Never auto-retry an ambiguous send.
        outcome = await bounded(() => transport.send({ recipient: current, notification, signal }), this.policy.sendTimeoutMs);
      } catch {
        outcome = { state: 'unknown', code: 'send_unknown' };
      }
      const retryAfter = Number.isSafeInteger(outcome?.retryAfterMs) && outcome.retryAfterMs >= 0 ? outcome.retryAfterMs : 0;
      if (outcome?.state === 'sent') finish('sent', 'accepted');
      else if (outcome?.state === 'retry') {
        if (job.attempts >= this.policy.maxAttempts) finish('failed', 'attempts_exhausted');
        else finish('pending', 'transport_rejected_retryable', this.#delay(job.attempts, retryAfter));
      } else if (outcome?.state === 'failed') finish('failed', 'transport_rejected');
      else finish('unknown', 'send_unknown');
    } catch {
      finish(sending ? 'unknown' : job.attempts >= this.policy.maxAttempts ? 'failed' : 'pending',
        sending ? 'send_unknown' : 'recipient_check_failed', this.#delay(job.attempts));
    }
    return true;
  }

  runOnce() {
    if (this.#running) return this.#running;
    this.#running = (async () => {
      this.activity = { ...this.activity, running: true, lastStartedAt: this.clock(), lastError: null };
      try {
        for (let i = 0; i < this.policy.batchSize && !this.#abort?.signal.aborted; i++) if (!await this.#plan()) break;
        for (let i = 0; i < this.policy.batchSize && !this.#abort?.signal.aborted; i++) if (!await this.#deliver()) break;
      } catch {
        this.activity.lastError = 'delivery_cycle_failed';
      } finally {
        this.activity.running = false;
        this.activity.lastFinishedAt = this.clock();
        this.#running = null;
      }
      return this.status();
    })();
    return this.#running;
  }

  start() {
    if (this.#loop) return;
    this.#abort = new AbortController();
    this.#loop = (async () => {
      while (!this.#abort.signal.aborted) {
        await this.runOnce();
        try { await sleep(this.policy.intervalMs, undefined, { signal: this.#abort.signal, ref: false }); }
        catch { break; }
      }
    })();
  }

  async stop() {
    this.#abort?.abort();
    await this.#loop;
    await this.#running;
    this.#loop = null;
  }

  status() {
    try { return { ...this.activity, available: true, ...this.store.status() }; }
    catch { return { ...this.activity, available: false, lastError: 'delivery_storage_unavailable' }; }
  }
}
