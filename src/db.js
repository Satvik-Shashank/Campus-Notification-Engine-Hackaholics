'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT NOT NULL UNIQUE,
  email TEXT,
  first_name TEXT,
  last_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS topic_members (
  topic TEXT NOT NULL,
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  PRIMARY KEY (topic, subscriber_id)
);

CREATE TABLE IF NOT EXISTS workflows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identifier TEXT NOT NULL UNIQUE,
  steps TEXT NOT NULL,
  critical INTEGER NOT NULL DEFAULT 0,
  correlation_key TEXT,
  critical_rules TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- NULL channel columns mean "inherit"; workflow_key '' marks the global row.
CREATE TABLE IF NOT EXISTS preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('global','workflow')),
  workflow_key TEXT NOT NULL DEFAULT '',
  email INTEGER CHECK (email IN (0,1)),
  in_app INTEGER CHECK (in_app IN (0,1)),
  read_only INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (subscriber_id, scope, workflow_key)
);

-- EVENT identity: one row per accepted trigger. transaction_id is the idempotency key.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT NOT NULL UNIQUE,
  workflow_id INTEGER NOT NULL REFERENCES workflows(id),
  payload TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('explicit','topic','broadcast')),
  recipients TEXT NOT NULL,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','processed','failed','canceled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  response TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status, next_attempt_at);

-- Fan-out progress lives in the DB so a failed fan-out resumes instead of dropping people.
CREATE TABLE IF NOT EXISTS event_recipients (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','done','skipped')),
  PRIMARY KEY (event_id, external_id)
);

-- NOTIFICATION identity: one logical notification per (event, subscriber).
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  transaction_id TEXT NOT NULL,
  workflow_id INTEGER NOT NULL REFERENCES workflows(id),
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id),
  payload TEXT NOT NULL,
  bypass_focus INTEGER NOT NULL DEFAULT 0,
  ignore_mutes INTEGER NOT NULL DEFAULT 0,
  correlation_value TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  delivery_email TEXT NOT NULL DEFAULT 'pending',
  delivery_in_app TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (event_id, subscriber_id)
);
CREATE INDEX IF NOT EXISTS idx_notifications_txn ON notifications(transaction_id, subscriber_id);
CREATE INDEX IF NOT EXISTS idx_notifications_sub ON notifications(workflow_id, subscriber_id, created_at);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  parent_job_id INTEGER REFERENCES jobs(id),
  step_index INTEGER NOT NULL,
  step_type TEXT NOT NULL CHECK (step_type IN ('digest','email','in-app')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','queued','running','completed','failed','skipped','merged',
                      'delayed','retrying','canceled','deferred','summarized')),
  subscriber_id INTEGER NOT NULL,
  workflow_id INTEGER NOT NULL,
  transaction_id TEXT NOT NULL,
  digest_key TEXT,
  digest_value TEXT,
  master_job_id INTEGER REFERENCES jobs(id),
  digest_events TEXT,
  run_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  next_retry_at INTEGER,
  last_error TEXT,
  idempotency_key TEXT NOT NULL,
  locked_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (notification_id, step_index)
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, run_at);
CREATE INDEX IF NOT EXISTS idx_jobs_txn ON jobs(transaction_id);
CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs(parent_job_id);
-- Only one DELAYED digest master per (subscriber, workflow, digest key/value). A concurrent
-- writer loses with a constraint error and merges instead of creating a second master.
CREATE UNIQUE INDEX IF NOT EXISTS uq_digest_master
  ON jobs(subscriber_id, workflow_id, digest_key, digest_value)
  WHERE step_type = 'digest' AND status = 'delayed';

-- DELIVERY ATTEMPT: one row per try at a job. Distinct from the notification and the provider result.
CREATE TABLE IF NOT EXISTS delivery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started','success','failed')),
  error TEXT,
  transient INTEGER,
  provider_message_id TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  UNIQUE (job_id, attempt_no)
);

-- PROVIDER RESULT lives on the message (provider_message_id) and on webhook updates (provider_status).
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id),
  channel TEXT NOT NULL CHECK (channel IN ('email','in-app')),
  subject TEXT,
  content TEXT NOT NULL,
  recipient_email TEXT,
  provider_message_id TEXT,
  provider_status TEXT,
  idempotency_key TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed','delivery_failed')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (subscriber_id, channel, idempotency_key),
  UNIQUE (job_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_messages_feed ON messages(subscriber_id, channel, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_provider ON messages(provider_message_id);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaction_id TEXT,
  notification_id INTEGER,
  job_id INTEGER,
  subscriber_id INTEGER,
  workflow_id INTEGER,
  step_type TEXT,
  event TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success','failure','skipped','info')),
  message TEXT,
  attempt INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_txn ON activity_log(transaction_id, id);
CREATE INDEX IF NOT EXISTS idx_activity_sub ON activity_log(subscriber_id, created_at);

-- Inbound provider webhooks, including rejected ones (audit). Secrets/signatures are never stored.
CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  verification TEXT NOT NULL,
  outcome TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  body_sha256 TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS focus_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended')),
  ended_at INTEGER
);
-- At most one active session per subscriber.
CREATE UNIQUE INDEX IF NOT EXISTS uq_focus_active ON focus_sessions(subscriber_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS held_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES focus_sessions(id) ON DELETE CASCADE,
  subscriber_id INTEGER NOT NULL,
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  correlation_value TEXT NOT NULL,
  payload TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('held','bypassed')),
  created_at INTEGER NOT NULL,
  UNIQUE (session_id, notification_id)
);

CREATE TABLE IF NOT EXISTS focus_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL UNIQUE REFERENCES focus_sessions(id) ON DELETE CASCADE,
  subscriber_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  text TEXT NOT NULL,
  notification_id INTEGER,
  created_at INTEGER NOT NULL
);
`;

/** SQLite wrapper with nested-safe transactions (BEGIN IMMEDIATE + savepoints). */
function openDatabase(dbPath = ':memory:') {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (dbPath !== ':memory:') raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec(SCHEMA);

  let depth = 0;
  return {
    raw,
    run: (sql, ...params) => raw.prepare(sql).run(...params),
    get: (sql, ...params) => raw.prepare(sql).get(...params),
    all: (sql, ...params) => raw.prepare(sql).all(...params),
    /** Run fn atomically; rolls back and rethrows on error. Nested calls use savepoints. */
    tx(fn) {
      const outer = depth === 0;
      const name = `sp${depth}`;
      raw.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
      depth += 1;
      try {
        const result = fn();
        depth -= 1;
        raw.exec(outer ? 'COMMIT' : `RELEASE ${name}`);
        return result;
      } catch (err) {
        depth -= 1;
        raw.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
        throw err;
      }
    },
    close: () => raw.close(),
  };
}

const isUniqueViolation = (err) => /UNIQUE constraint failed/i.test(String(err && err.message));

module.exports = { openDatabase, isUniqueViolation };
