import { createHash, randomUUID } from 'node:crypto';
import { canRead, expectedVersion, identity, nextStatus, operator, pageOptions, requireThat, statusTransitions, text } from './domain.mjs';

const defaults = Object.freeze({ subjectLength: 200, messageLength: 10000, writesPerMinute: 20 });

/** Public application boundary. Principals must come from a trusted host identity adapter. */
export class SupportService {
  constructor(store, { policy = {}, clock = Date.now } = {}) {
    this.store = store;
    this.clock = clock;
    this.policy = { ...defaults, ...policy };
    for (const value of Object.values(this.policy)) requireThat(Number.isSafeInteger(value) && value > 0, 'invalid_policy');
  }

  #ticket(p, id) {
    const ticket = this.store.find(p.tenant, text(id, 128, 'invalid_ticket_id'));
    canRead(p, ticket);
    return ticket;
  }
  #page(rows, limit) {
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    return { items, nextCursor: hasMore ? items.at(-1).seq : null };
  }
  list(principal, options) {
    const p = identity(principal), page = pageOptions(options);
    return this.#page(this.store.list(p, { ...page, limit: page.limit + 1 }), page.limit);
  }
  get(principal, id) {
    const p = identity(principal), ticket = this.#ticket(p, id);
    return { ...ticket, allowedTransitions: p.role === 'operator' ? statusTransitions[ticket.status] : [] };
  }
  messages(principal, id, options) {
    const p = identity(principal), page = pageOptions(options);
    this.#ticket(p, id);
    return this.#page(this.store.messages(p, id, { ...page, limit: page.limit + 1 }), page.limit);
  }
  audit(principal, id, options) {
    const p = identity(principal), page = pageOptions(options);
    operator(p);
    this.#ticket(p, id);
    return this.#page(this.store.audit(p.tenant, id, { ...page, limit: page.limit + 1 }), page.limit);
  }
  #write(p, operation, key, command, perform) {
    requireThat(typeof key === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(key), 'idempotency_key_required');
    const fingerprint = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    return this.store.transaction(() => {
      const previous = this.store.replay(p, operation, key);
      if (previous) {
        requireThat(previous.fingerprint === fingerprint, 'idempotency_conflict', 409);
        return { ...JSON.parse(previous.receipt), replayed: true };
      }
      const receipt = perform();
      this.store.remember(p, operation, key, fingerprint, receipt);
      return { ...receipt, replayed: false };
    });
  }
  #rate(p, now) {
    requireThat(this.store.recentWrites(p, now - 60000) < this.policy.writesPerMinute, 'rate_limited', 429);
  }
  #message(p, ticketId, body, visibility, now) {
    const id = randomUUID();
    this.store.addMessage({ id, tenant: p.tenant, ticket_id: ticketId, author: p.subject, author_role: p.role, visibility, body, now });
    if (visibility === 'public') this.store.enqueue(p, ticketId, id, now);
    return id;
  }
  create(principal, input, key) {
    const p = identity(principal);
    requireThat(p.role === 'user', 'user_required', 403);
    const command = { subject: text(input?.subject, this.policy.subjectLength, 'invalid_subject'), body: text(input?.body, this.policy.messageLength, 'invalid_body') };
    return this.#write(p, 'create', key, command, () => {
      const now = this.clock(), id = randomUUID();
      this.#rate(p, now);
      this.store.create({ id, tenant: p.tenant, owner: p.subject, subject: command.subject, now });
      const messageId = this.#message(p, id, command.body, 'public', now);
      this.store.record(p, id, 'created', {}, now);
      return { id, version: 1, messageId };
    });
  }
  change(principal, id, input, key) {
    const p = identity(principal);
    this.#ticket(p, id); // Never replay an operation whose current access was revoked.
    const command = this.#command(p, input);
    return this.#write(p, `change:${id}`, key, command, () => {
      const ticket = this.#ticket(p, id), now = this.clock();
      requireThat(ticket.version === command.version, 'version_conflict', 409);
      let messageId;
      const details = {};
      if (command.type === 'message') {
        this.#rate(p, now);
        messageId = this.#message(p, id, command.body, command.visibility, now);
        details.visibility = command.visibility;
        details.messageId = messageId;
        if (p.role === 'user' && ['waiting_user', 'resolved'].includes(ticket.status)) {
          details.from = ticket.status;
          ticket.status = 'in_progress';
          details.to = ticket.status;
        }
      } else if (command.type === 'status') {
        details.from = ticket.status;
        ticket.status = nextStatus(ticket.status, command.status);
        details.to = ticket.status;
      } else {
        details.from = ticket.assignee;
        // Assignment to self/unassignment requires no enumeration of product identities.
        ticket.assignee = command.assigned ? p.subject : null;
        details.to = ticket.assignee;
      }
      ticket.updated_at = now;
      this.store.update(ticket, command.version);
      this.store.record(p, id, command.type === 'message' ? 'message_added' : `${command.type}_changed`, details, now);
      return { id, version: command.version + 1, ...(messageId ? { messageId } : {}) };
    });
  }
  #command(p, input) {
    requireThat(input && typeof input === 'object', 'invalid_command');
    const version = expectedVersion(input.version);
    if (input.type === 'message') {
      const visibility = input.visibility ?? 'public';
      requireThat(['public', 'internal'].includes(visibility), 'invalid_visibility');
      if (visibility === 'internal') operator(p);
      return { type: 'message', version, body: text(input.body, this.policy.messageLength, 'invalid_body'), visibility };
    }
    operator(p);
    if (input.type === 'status') return { type: 'status', version, status: text(input.status, 32, 'invalid_status') };
    requireThat(input.type === 'assignment' && typeof input.assigned === 'boolean', 'invalid_command');
    return { type: 'assignment', version, assigned: input.assigned };
  }
}
