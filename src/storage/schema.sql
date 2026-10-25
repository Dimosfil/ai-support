CREATE TABLE tickets (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  tenant TEXT NOT NULL,
  owner TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('new','in_progress','waiting_user','resolved')),
  assignee TEXT,
  version INTEGER NOT NULL CHECK(version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(tenant,id)
);
CREATE INDEX tickets_queue ON tickets(tenant, seq DESC);
CREATE INDEX tickets_owner ON tickets(tenant, owner, seq DESC);
CREATE TABLE messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  tenant TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  author TEXT NOT NULL,
  author_role TEXT NOT NULL CHECK(author_role IN ('user','operator')),
  visibility TEXT NOT NULL CHECK(visibility IN ('public','internal')),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(tenant,ticket_id) REFERENCES tickets(tenant,id)
);
CREATE INDEX messages_history ON messages(tenant,ticket_id,seq DESC);
CREATE TABLE audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(tenant,ticket_id) REFERENCES tickets(tenant,id)
);
CREATE INDEX audit_actor ON audit(tenant,actor,created_at);
CREATE TABLE idempotency (
  tenant TEXT NOT NULL,
  actor TEXT NOT NULL,
  operation TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  receipt TEXT NOT NULL,
  PRIMARY KEY(tenant,actor,operation,key)
);
-- Durable notification intents only. G2 owns dispatch, recipient revalidation,
-- retry/backoff and provider delivery results. Internal notes never enter here.
CREATE TABLE notification_intents (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  audience TEXT NOT NULL CHECK(audience IN ('owner','operators')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','failed')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(tenant,ticket_id) REFERENCES tickets(tenant,id),
  FOREIGN KEY(message_id) REFERENCES messages(id)
);
PRAGMA user_version = 1;
