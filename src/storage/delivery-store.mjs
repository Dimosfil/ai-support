import { randomUUID } from 'node:crypto';

const terminal = new Set(['sent', 'failed', 'skipped', 'unknown']);

/** Shares SupportService's database/unit of work. Never holds a transaction over I/O. */
export class SqliteDeliveryStore {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    if (!store.deliveryReady())
      throw new Error('delivery_schema_required');
  }

  context(seq) {
    return this.db.prepare(`SELECT n.seq,n.tenant,n.ticket_id,n.message_id,n.audience,
      t.owner,t.subject,t.status,t.version,m.author,m.author_role,m.body,m.visibility
      FROM notification_intents n
      JOIN tickets t ON t.tenant=n.tenant AND t.id=n.ticket_id
      JOIN messages m ON m.tenant=n.tenant AND m.ticket_id=n.ticket_id AND m.id=n.message_id
      WHERE n.seq=? AND m.visibility='public'`).get(seq);
  }

  claimPlan(now, leaseMs, maxAttempts) {
    return this.store.transaction(() => {
      this.db.exec(`INSERT OR IGNORE INTO notification_plans(intent_seq)
        SELECT seq FROM notification_intents WHERE state='pending'`);
      const row = this.db.prepare(`SELECT p.* FROM notification_plans p
        JOIN notification_intents n ON n.seq=p.intent_seq
        WHERE p.planned=0 AND n.state='pending' AND p.next_at<=?
          AND (p.lease_until IS NULL OR p.lease_until<=?) ORDER BY p.intent_seq LIMIT 1`).get(now, now);
      if (!row) return null;
      if (row.attempts >= maxAttempts) {
        this.db.prepare("UPDATE notification_intents SET state='failed' WHERE seq=?").run(row.intent_seq);
        return { exhausted: true };
      }
      const token = randomUUID();
      this.db.prepare('UPDATE notification_plans SET attempts=attempts+1,lease_token=?,lease_until=? WHERE intent_seq=?')
        .run(token, now + leaseMs, row.intent_seq);
      return { seq: row.intent_seq, attempts: row.attempts + 1, token };
    });
  }

  finishPlan(plan, recipients, now) {
    return this.store.transaction(() => {
      const changed = this.db.prepare(`UPDATE notification_plans SET planned=1,lease_token=NULL,lease_until=NULL,last_code=?
        WHERE intent_seq=? AND lease_token=? AND lease_until>?`)
        .run(recipients.length ? null : 'no_recipients', plan.seq, plan.token, now);
      if (!changed.changes) return false;
      for (const recipient of recipients) {
        this.db.prepare(`INSERT INTO notification_deliveries(id,intent_seq,recipient_id,recipient)
          VALUES(?,?,?,?)`).run(randomUUID(), plan.seq, recipient.id, JSON.stringify(recipient));
      }
      this.#refresh(plan.seq);
      return true;
    });
  }

  failPlan(plan, now, delay, code, exhausted) {
    this.store.transaction(() => {
      const changed = this.db.prepare(`UPDATE notification_plans SET lease_token=NULL,lease_until=NULL,next_at=?,last_code=?
        WHERE intent_seq=? AND lease_token=? AND lease_until>?`).run(now + delay, code, plan.seq, plan.token, now);
      if (changed.changes && exhausted)
        this.db.prepare("UPDATE notification_intents SET state='failed' WHERE seq=?").run(plan.seq);
    });
  }

  claimDelivery(now, leaseMs) {
    return this.store.transaction(() => {
      const expired = this.db.prepare(`SELECT * FROM notification_deliveries
        WHERE state IN ('leased','sending') AND lease_until<=?`).all(now);
      for (const row of expired) {
        const state = row.state === 'sending' ? 'unknown' : 'pending';
        this.db.prepare(`UPDATE notification_deliveries SET state=?,lease_token=NULL,lease_until=NULL,last_code='lease_expired'
          WHERE id=?`).run(state, row.id);
        this.db.prepare(`UPDATE notification_attempts SET finished_at=?,outcome=?,code='lease_expired'
          WHERE delivery_id=? AND attempt=?`).run(now, state, row.id, row.attempts);
        this.#refresh(row.intent_seq);
      }
      const row = this.db.prepare(`SELECT * FROM notification_deliveries
        WHERE state='pending' AND next_at<=? ORDER BY intent_seq,id LIMIT 1`).get(now);
      if (!row) return null;
      const token = randomUUID(), attempts = row.attempts + 1;
      this.db.prepare("UPDATE notification_deliveries SET state='leased',attempts=?,lease_token=?,lease_until=? WHERE id=?")
        .run(attempts, token, now + leaseMs, row.id);
      this.db.prepare(`INSERT INTO notification_attempts(delivery_id,attempt,started_at,outcome)
        VALUES(?,?,?,'checking')`).run(row.id, attempts, now);
      return { ...row, attempts, token, recipient: JSON.parse(row.recipient) };
    });
  }

  beginSend(job, now) {
    return this.store.transaction(() => {
      const changed = this.db.prepare(`UPDATE notification_deliveries SET state='sending'
        WHERE id=? AND state='leased' AND lease_token=? AND lease_until>?`).run(job.id, job.token, now);
      if (changed.changes) this.db.prepare(`UPDATE notification_attempts SET outcome='sending'
        WHERE delivery_id=? AND attempt=?`).run(job.id, job.attempts);
      return !!changed.changes;
    });
  }

  finish(job, now, state, code, delay = 0) {
    if (!terminal.has(state) && state !== 'pending') throw new Error('invalid_delivery_state');
    return this.store.transaction(() => {
      const changed = this.db.prepare(`UPDATE notification_deliveries
        SET state=?,next_at=?,last_code=?,lease_token=NULL,lease_until=NULL
        WHERE id=? AND lease_token=? AND lease_until>? AND state IN ('leased','sending')`)
        .run(state, now + delay, code, job.id, job.token, now);
      if (!changed.changes) return false;
      this.db.prepare(`UPDATE notification_attempts SET finished_at=?,outcome=?,code=?
        WHERE delivery_id=? AND attempt=?`).run(now, state, code, job.id, job.attempts);
      this.#refresh(job.intent_seq);
      return true;
    });
  }

  #refresh(seq) {
    const rows = this.db.prepare('SELECT state FROM notification_deliveries WHERE intent_seq=?').all(seq);
    const pending = rows.some(row => !terminal.has(row.state));
    const sent = rows.length > 0 && rows.every(row => row.state === 'sent');
    this.db.prepare('UPDATE notification_intents SET state=? WHERE seq=?')
      .run(pending ? 'pending' : sent ? 'sent' : 'failed', seq);
  }

  status() {
    const deliveries = Object.fromEntries(this.db.prepare('SELECT state,count(*) AS count FROM notification_deliveries GROUP BY state')
      .all().map(row => [row.state, row.count]));
    const intents = Object.fromEntries(this.db.prepare('SELECT state,count(*) AS count FROM notification_intents GROUP BY state')
      .all().map(row => [row.state, row.count]));
    return { intents, deliveries };
  }
}
