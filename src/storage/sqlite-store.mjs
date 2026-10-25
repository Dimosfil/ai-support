import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { SupportError } from '../core/domain.mjs';

/** Synchronous unit of work; do not pass async callbacks to transaction(). */
export class SqliteStore {
  #transactionDepth = 0;
  constructor(filename) {
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.transaction(() => {
        const version = this.db.prepare('PRAGMA user_version').get().user_version;
        if (version === 0) {
          this.db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
          this.db.exec(readFileSync(new URL('./delivery-schema.sql', import.meta.url), 'utf8'));
        } else if (![1, 2].includes(version)) throw new Error('Unsupported support database schema');
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() { this.db.close(); }
  deliveryReady() { return this.db.prepare('PRAGMA user_version').get().user_version === 2; }
  inboundReceipt(source, eventId) {
    return this.db.prepare('SELECT * FROM support_inbound_receipts WHERE source=? AND event_id=?').get(source, eventId);
  }
  rememberInbound(source, eventId, fingerprint, receipt) {
    this.db.prepare('INSERT INTO support_inbound_receipts VALUES(?,?,?,?)').run(source, eventId, fingerprint, JSON.stringify(receipt));
  }
  transaction(work) {
    const nested = this.#transactionDepth > 0;
    const savepoint = `support_${this.#transactionDepth}`;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.#transactionDepth++;
    try {
      const result = work();
      if (result?.then) throw new Error('SQLite work must be synchronous');
      this.db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      this.db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
      throw error;
    } finally {
      this.#transactionDepth--;
    }
  }

  replay(p, operation, key) {
    return this.db.prepare('SELECT fingerprint,receipt FROM idempotency WHERE tenant=? AND actor=? AND operation=? AND key=?')
      .get(p.tenant, p.subject, operation, key);
  }
  remember(p, operation, key, fingerprint, receipt) {
    this.db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?,?)')
      .run(p.tenant, p.subject, operation, key, fingerprint, JSON.stringify(receipt));
  }
  find(tenant, id) { return this.db.prepare('SELECT * FROM tickets WHERE tenant=? AND id=?').get(tenant, id); }
  list(p, { before, limit }) {
    return this.db.prepare(`SELECT * FROM tickets WHERE tenant=? AND seq<?
      ${p.role === 'operator' ? '' : 'AND owner=?'} ORDER BY seq DESC LIMIT ?`)
      .all(...[p.tenant, before, ...(p.role === 'operator' ? [] : [p.subject]), limit]);
  }
  messages(p, id, { before, limit }) {
    return this.db.prepare(`SELECT * FROM messages WHERE tenant=? AND ticket_id=? AND seq<?
      ${p.role === 'operator' ? '' : "AND visibility='public'"} ORDER BY seq DESC LIMIT ?`)
      .all(p.tenant, id, before, limit);
  }
  audit(tenant, id, { before, limit }) {
    return this.db.prepare('SELECT * FROM audit WHERE tenant=? AND ticket_id=? AND seq<? ORDER BY seq DESC LIMIT ?')
      .all(tenant, id, before, limit).map(row => ({ ...row, details: JSON.parse(row.details) }));
  }
  create(ticket) {
    this.db.prepare(`INSERT INTO tickets(id,tenant,owner,subject,status,version,created_at,updated_at)
      VALUES(?,?,?,?,?,1,?,?)`).run(ticket.id, ticket.tenant, ticket.owner, ticket.subject, 'new', ticket.now, ticket.now);
  }
  update(ticket, previousVersion) {
    const changed = this.db.prepare(`UPDATE tickets SET status=?,assignee=?,version=version+1,updated_at=?
      WHERE tenant=? AND id=? AND version=?`)
      .run(ticket.status, ticket.assignee, ticket.updated_at, ticket.tenant, ticket.id, previousVersion);
    if (changed.changes !== 1) throw new SupportError('version_conflict', 409);
  }
  addMessage(message) {
    this.db.prepare('INSERT INTO messages(id,tenant,ticket_id,author,author_role,visibility,body,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(message.id, message.tenant, message.ticket_id, message.author, message.author_role, message.visibility, message.body, message.now);
  }
  record(p, id, action, details, now) {
    this.db.prepare('INSERT INTO audit(tenant,ticket_id,actor,action,details,created_at) VALUES(?,?,?,?,?,?)')
      .run(p.tenant, id, p.subject, action, JSON.stringify(details), now);
  }
  enqueue(p, id, messageId, now) {
    this.db.prepare('INSERT INTO notification_intents(tenant,ticket_id,message_id,audience,created_at) VALUES(?,?,?,?,?)')
      .run(p.tenant, id, messageId, p.role === 'operator' ? 'owner' : 'operators', now);
  }
  recentWrites(p, since) {
    return this.db.prepare("SELECT count(*) AS count FROM audit WHERE tenant=? AND actor=? AND created_at>=? AND action IN ('created','message_added')")
      .get(p.tenant, p.subject, since).count;
  }
}
