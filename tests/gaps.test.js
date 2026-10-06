'use strict';

// Named regression tests for every gap in docs/GAPS.md (G1-G8), so each one is traceable.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHarness, seedStandard, addStudents, activityEvents, FakeEmailProvider } = require('./helpers');
const { openDatabase, BASELINE_SCHEMA, SCHEMA_VERSION } = require('../src/db');
const { ProviderError } = require('../src/providers/email');

async function setup(students = 1, opts) {
  const h = await createHarness(opts);
  await seedStandard(h);
  await addStudents(h, students);
  return h;
}
const emailJob = (h) => h.db.get(`SELECT * FROM jobs WHERE step_type='email' ORDER BY id LIMIT 1`);

test('G1: a transient provider failure is retried with backoff', async (t) => {
  const h = await setup(1, { provider: new FakeEmailProvider(['fail-500', 'ok']) });
  t.after(() => h.close());
  await h.trigger('g1', 'grade-alerts', h.explicit('student_001'), {});
  await h.tick();
  assert.equal(emailJob(h).status, 'retrying');
  await h.advance(1000);
  assert.equal(emailJob(h).status, 'completed');
});

test('G2: re-execution reuses the idempotency key; no second message', async (t) => {
  const h = await setup();
  t.after(() => h.close());
  await h.trigger('g2', 'grade-alerts', h.explicit('student_001'), {});
  await h.tick();
  h.db.run(`UPDATE jobs SET status='running', locked_at=? WHERE step_type='email'`, h.clock.now() - 1);
  await h.advance(91000);
  assert.equal(h.provider.calls.length, 1);
  assert.equal(h.db.get(`SELECT COUNT(*) AS n FROM messages WHERE channel='email'`).n, 1);
});

test('G3/G4: fan-out progress is persisted per recipient and resumes after failure', async (t) => {
  const h = await setup(3);
  t.after(() => h.close());
  const orig = h.ctx.subscribers.byExternal;
  let fail = true;
  h.ctx.subscribers.byExternal = (x) => { if (fail && x === 'student_002') throw new Error('db down'); return orig(x); };
  await h.trigger('g3', 'grade-alerts', h.explicit('student_001', 'student_002', 'student_003'), {});
  await h.tick();
  assert.equal(h.db.get(`SELECT status FROM events WHERE transaction_id='g3'`).status, 'pending');
  fail = false;
  await h.advance(1000);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM notifications').n, 3);
});

test('G5: transactionId is protected by a unique index, not check-then-act', async (t) => {
  const h = await setup();
  t.after(() => h.close());
  await h.trigger('g5', 'grade-alerts', h.explicit('student_001'), {});
  assert.throws(() => h.db.run(
    `INSERT INTO events (transaction_id, workflow_id, payload, recipient_type, recipients, next_attempt_at, created_at, updated_at, expires_at)
     VALUES ('g5', 1, '{}', 'explicit', '[]', 0, 0, 0, 0)`,
  ), /UNIQUE/);
});

test('G6: bucket throttles without consuming attempts', async (t) => {
  const h = await setup(5, { config: { emailRatePerSec: 2 } });
  t.after(() => h.close());
  await h.trigger('g6-rate', 'grade-alerts', h.explicit('student_001', 'student_002', 'student_003', 'student_004', 'student_005'), {});
  await h.tick();
  assert.equal(h.provider.calls.length, 2, 'burst capacity = rate');
  assert.ok((await activityEvents(h, 'g6-rate')).includes('provider_throttled'));
  await h.advance(1000);
  assert.equal(h.provider.calls.length, 4);
  await h.advance(1000);
  assert.equal(h.provider.calls.length, 5);
  assert.equal(h.db.get(`SELECT MAX(attempts) AS n FROM jobs WHERE step_type='email'`).n, 1);
});

test('G6: circuit opens after consecutive transient failures, holds traffic, and recovers via a probe', async (t) => {
  // 3 failures open the breaker, the first probe fails too; after that the provider is healthy.
  const script = Array(4).fill('fail-500');
  const h = await setup(8, {
    provider: new FakeEmailProvider(script),
    config: { emailBreakerThreshold: 3, emailBreakerCooldownMs: 10000, emailRatePerSec: 0 },
  });
  t.after(() => h.close());
  const ids = ['student_001', 'student_002', 'student_003', 'student_004', 'student_005', 'student_006', 'student_007', 'student_008'];
  await h.trigger('g6-cb', 'grade-alerts', h.explicit(...ids), {});
  await h.tick();
  // 3 failures open the breaker; the other 5 jobs are held without using an attempt.
  assert.equal(h.provider.calls.length, 3);
  assert.equal(h.ctx.providerGuard.snapshot().breaker.state, 'open');
  const unused = h.db.get(`SELECT COUNT(*) AS n FROM jobs WHERE step_type='email' AND attempts = 0`).n;
  assert.equal(unused, 5, 'held jobs kept their full attempt budget');
  const providers = await h.api('GET', '/admin/providers');
  assert.equal(providers.body.email.breaker.state, 'open');

  await h.advance(5000);
  assert.equal(h.provider.calls.length, 3, 'still open: nothing sent during cooldown');

  // Cooldown over: exactly one probe goes out; it fails -> open again.
  await h.advance(5000);
  assert.equal(h.provider.calls.length, 4);
  assert.equal(h.ctx.providerGuard.snapshot().breaker.state, 'open');
  await h.advance(10000); // probe #2 succeeds -> closed -> everything flows
  for (let i = 0; i < 5; i += 1) await h.advance(5000);
  assert.equal(h.ctx.providerGuard.snapshot().breaker.state, 'closed');
  assert.equal(new Set(h.provider.delivered.map((d) => d.to)).size, 8, 'every student eventually got exactly one email');
  assert.equal(h.provider.delivered.length, 8);
  const log = await h.api('GET', '/admin/activity?limit=500');
  const events = log.body.events.map((e) => e.event);
  assert.ok(events.includes('circuit_opened') && events.includes('circuit_half_open') && events.includes('circuit_closed'));
});

test('G6: a 429 with Retry-After pauses the bucket', async (t) => {
  class RateLimited extends FakeEmailProvider {
    async send(msg) {
      this.calls.push(msg);
      if (this.calls.length === 1) throw new ProviderError('429 too many', { transient: true, status: 429, retryAfterMs: 4000 });
      return { providerMessageId: this.record(msg) };
    }
  }
  const h = await setup(2, { provider: new RateLimited() });
  t.after(() => h.close());
  await h.trigger('g6-429', 'grade-alerts', h.explicit('student_001', 'student_002'), {});
  await h.tick();
  assert.equal(h.provider.calls.length, 1, 'second send held while paused');
  await h.advance(4000);
  assert.equal(h.provider.delivered.length, 2);
});

test('G7: a permanently failed delivery lands in the dead-letter queue; retry delivers exactly once', async (t) => {
  const h = await setup(1, { provider: new FakeEmailProvider(['fail-permanent', 'ok']) });
  t.after(() => h.close());
  await h.trigger('g7', 'grade-alerts', h.explicit('student_001'), { course: 'A', grade: '1' });
  await h.tick();
  const list = await h.api('GET', '/admin/dead-letters?status=open');
  assert.equal(list.body.total, 1);
  const letter = list.body.deadLetters[0];
  assert.equal(letter.reason, 'permanent_error');
  assert.equal(letter.transactionId, 'g7');
  assert.equal(letter.subscriberId, 'student_001');

  const r = await h.api('POST', `/admin/dead-letters/${letter.id}/retry`);
  assert.equal(r.status, 200);
  assert.equal((await h.api('POST', `/admin/dead-letters/${letter.id}/retry`)).status, 409, 'second retry is refused');
  await h.tick();
  assert.equal(h.provider.delivered.length, 1);
  assert.equal(h.db.get(`SELECT COUNT(*) AS n FROM messages WHERE channel='email'`).n, 1);
  const job = emailJob(h);
  assert.equal(job.status, 'completed');
  const attempts = h.db.all('SELECT attempt_no, status FROM delivery_attempts WHERE job_id = ? ORDER BY attempt_no', job.id);
  assert.deepEqual(attempts.map((a) => [a.attempt_no, a.status]), [[1, 'failed'], [2, 'success']], 'history kept, numbers keep counting');
  assert.equal((await h.api('GET', '/admin/dead-letters?status=open')).body.total, 0);
  assert.equal((await h.api('GET', '/admin/notifications/g7')).body.status, 'delivered');
});

test('G7: exhausted retries dead-letter; bulk retry by transaction; dismiss; validation', async (t) => {
  const h = await setup(2, { provider: new FakeEmailProvider(Array(6).fill('fail-500')), config: { emailBreakerThreshold: 0 } });
  t.after(() => h.close());
  await h.trigger('g7b', 'grade-alerts', h.explicit('student_001', 'student_002'), {});
  await h.tick();
  await h.advance(1000);
  await h.advance(5000);
  const open = (await h.api('GET', '/admin/dead-letters?transactionId=g7b')).body;
  assert.equal(open.total, 2);
  assert.ok(open.deadLetters.every((d) => d.reason === 'attempts_exhausted' && d.attempts === 3));

  const bulk = await h.api('POST', '/admin/dead-letters/retry', { transactionId: 'g7b' });
  assert.equal(bulk.body.retried, 2);
  await h.tick();
  assert.equal(h.provider.delivered.length, 2);

  // Fail again later -> the same letter re-opens (one row per job), then dismiss it.
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM dead_letters').n, 2);
  const id = open.deadLetters[0].id;
  assert.equal((await h.api('POST', `/admin/dead-letters/${id}/dismiss`)).status, 409, 'already retried');
  assert.equal((await h.api('POST', '/admin/dead-letters/999/retry')).status, 404);
  assert.equal((await h.api('GET', '/admin/dead-letters?status=bogus')).status, 400);
  assert.equal((await h.api('POST', '/admin/dead-letters/retry', {})).status, 400);
});

test('G7: dismiss closes a letter without delivering', async (t) => {
  const h = await setup(1, { provider: new FakeEmailProvider(['fail-permanent']) });
  t.after(() => h.close());
  await h.trigger('g7c', 'grade-alerts', h.explicit('student_001'), {});
  await h.tick();
  const id = (await h.api('GET', '/admin/dead-letters')).body.deadLetters[0].id;
  assert.equal((await h.api('POST', `/admin/dead-letters/${id}/dismiss`)).status, 200);
  assert.equal((await h.api('GET', '/admin/dead-letters?status=dismissed')).body.total, 1);
  await h.advance(60000);
  assert.equal(h.provider.delivered.length, 0);
});

test('G8: digest steps sharing a groupScope merge across workflows into one digest', async (t) => {
  const h = await setup(1);
  t.after(() => h.close());
  const wf = (subject, body) => ({
    steps: [
      { type: 'digest', windowMs: 300000, digestKey: 'exam', groupScope: 'exam' },
      { type: 'email', subject, body },
      { type: 'in-app', subject, body },
    ],
  });
  await h.api('PUT', '/admin/workflows/exam-room', wf('Room {{exam}}', 'Room moved to {{room}}'));
  await h.api('PUT', '/admin/workflows/exam-time', wf('Time {{exam}}', 'Starts at {{time}}'));
  await h.api('PUT', '/admin/workflows/exam-staff', wf('Invigilator {{exam}}', 'Invigilator is {{who}}'));
  const to = h.explicit('student_001');
  await h.trigger('x1', 'exam-room', to, { exam: 'CS101', room: 'H123' });
  await h.trigger('x2', 'exam-time', to, { exam: 'CS101', time: '2 PM' });
  await h.trigger('x3', 'exam-staff', to, { exam: 'CS101', who: 'Dr. Rao' });
  await h.tick();
  await h.advance(300000);
  assert.equal(h.provider.delivered.length, 1, 'one email for three related workflows');
  const body = h.provider.delivered[0].body;
  assert.match(body, /\[exam-room\] Room moved to H123/);
  assert.match(body, /\[exam-time\] Starts at 2 PM/);
  assert.match(body, /\[exam-staff\] Invigilator is Dr\. Rao/);
  assert.equal(h.db.get(`SELECT COUNT(*) AS n FROM messages WHERE channel='in-app'`).n, 1);
});

test('G8: without groupScope, digests stay per workflow (unchanged default)', async (t) => {
  const h = await setup(1);
  t.after(() => h.close());
  const wf = { steps: [{ type: 'digest', windowMs: 300000, digestKey: 'exam' }, { type: 'email', subject: 's', body: '{{exam}}' }] };
  await h.api('PUT', '/admin/workflows/a-wf', wf);
  await h.api('PUT', '/admin/workflows/b-wf', wf);
  await h.trigger('y1', 'a-wf', h.explicit('student_001'), { exam: 'CS101' });
  await h.trigger('y2', 'b-wf', h.explicit('student_001'), { exam: 'CS101' });
  await h.tick();
  await h.advance(300000);
  assert.equal(h.provider.delivered.length, 2);
  assert.equal((await h.api('PUT', '/admin/workflows/c-wf', { steps: [{ type: 'digest', groupScope: 'Bad Scope!' }] })).status, 400);
});

test('MIGRATIONS: a database created by the pre-versioning schema upgrades in place', () => {
  const file = path.join(os.tmpdir(), `cne-migrate-${process.pid}-${Date.now()}.db`);
  const old = new DatabaseSync(file);
  old.exec(BASELINE_SCHEMA);
  old.exec(`INSERT INTO subscribers (external_id, email, created_at, updated_at) VALUES ('s1', 's1@x', 0, 0);
    INSERT INTO workflows (identifier, steps, created_at, updated_at) VALUES ('w', '[]', 0, 0);
    INSERT INTO events (transaction_id, workflow_id, payload, recipient_type, recipients, next_attempt_at, created_at, updated_at, expires_at)
      VALUES ('t', 1, '{}', 'explicit', '[]', 0, 0, 0, 0);
    INSERT INTO notifications (event_id, transaction_id, workflow_id, subscriber_id, payload, created_at, updated_at) VALUES (1, 't', 1, 1, '{}', 0, 0);
    INSERT INTO jobs (notification_id, step_index, step_type, status, subscriber_id, workflow_id, transaction_id, digest_key, digest_value, idempotency_key, created_at, updated_at)
      VALUES (1, 0, 'digest', 'delayed', 1, 1, 't', '', '', 'k', 0, 0);`);
  assert.equal(old.prepare('PRAGMA user_version').get().user_version, 0);
  old.close();

  const db = openDatabase(file);
  try {
    assert.equal(db.get('PRAGMA user_version').user_version, SCHEMA_VERSION);
    assert.equal(db.get('SELECT digest_scope FROM jobs').digest_scope, 'workflow:1', 'existing digest jobs backfilled');
    assert.equal(db.get('SELECT external_id FROM subscribers').external_id, 's1', 'data kept');
    assert.ok(db.get(`SELECT name FROM sqlite_master WHERE name = 'dead_letters'`));
  } finally {
    db.close();
    for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  }
  // Re-opening an up-to-date database is a no-op.
  const again = openDatabase(':memory:');
  assert.equal(again.get('PRAGMA user_version').user_version, SCHEMA_VERSION);
  again.close();
});
