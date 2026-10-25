CREATE TABLE notification_plans (
  intent_seq INTEGER PRIMARY KEY REFERENCES notification_intents(seq),
  planned INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER,
  last_code TEXT
);
CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY,
  intent_seq INTEGER NOT NULL REFERENCES notification_intents(seq),
  recipient_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','leased','sending','sent','failed','skipped','unknown')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER,
  last_code TEXT,
  UNIQUE(intent_seq,recipient_id)
);
CREATE INDEX notification_delivery_ready ON notification_deliveries(state,next_at);
CREATE TABLE notification_attempts (
  delivery_id TEXT NOT NULL REFERENCES notification_deliveries(id),
  attempt INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  outcome TEXT NOT NULL,
  code TEXT,
  PRIMARY KEY(delivery_id,attempt)
);
-- Only transport metadata goes in these tables, never tokens or message bodies.
CREATE TABLE support_inbound_receipts (
  source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  receipt TEXT NOT NULL,
  PRIMARY KEY(source,event_id)
);
PRAGMA user_version = 2;
