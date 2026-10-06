'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, seedStandard, addStudents, activityEvents } = require('./helpers');

async function setup(students = 1, opts) {
  const h = await createHarness(opts);
  await seedStandard(h);
  await addStudents(h, students);
  return h;
}

test('RELIABILITY: fan-out spans chunks and every recipient gets exactly one notification', async (t) => {
  const h = await setup(250);
  t.after(() => h.close());
  const r = await h.api('POST', '/events/trigger/broadcast', { transactionId: 'big', workflowIdentifier: 'grade-alerts', payload: { course: 'A', grade: '1' } });
  assert.equal(r.body.recipientCount, 250);
  await h.tick();
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM notifications').n, 250);
  // G6: the default 100 emails/s bucket spreads the burst out instead of hammering the provider.
  assert.equal(h.provider.delivered.length, 100);
  for (let i = 0; i < 3; i += 1) await h.advance(1000);
  assert.equal(h.provider.delivered.length, 250);
  assert.equal(h.provider.calls.length, 250, 'throttled jobs never reached the provider early');
  assert.equal(h.db.get(`SELECT MAX(attempts) AS n FROM jobs WHERE step_type='email'`).n, 1, 'throttling used no attempts');
  assert.equal(h.db.get(`SELECT COUNT(*) AS n FROM messages WHERE channel='in-app'`).n, 250);
  assert.equal(h.db.get(`SELECT COUNT(*) AS n FROM event_recipients WHERE state != 'done'`).n, 0);
});

test('RELIABILITY: a mid-fan-out failure resumes later and loses nobody and duplicates nobody', async (t) => {
  const h = await setup(5);
  t.after(() => h.close());
  const subs = h.ctx.subscribers;
  const original = subs.byExternal;
  let boom = true;
  subs.byExternal = (ext) => {
    if (boom && ext === 'student_004') throw new Error('database connection lost');
    return original(ext);
  };
  await h.api('POST', '/events/trigger/broadcast', { transactionId: 'resume', workflowIdentifier: 'grade-alerts', payload: { course: 'A', grade: '1' } });
  await h.tick();

  // The chunk failed atomically: event is retryable, error is visible, nothing half-written.
  let ev = h.db.get(`SELECT status, attempts, last_error FROM events WHERE transaction_id = 'resume'`);
  assert.equal(ev.status, 'pending');
  assert.equal(ev.attempts, 1);
  assert.match(ev.last_error, /connection lost/);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM notifications').n, 0);
  assert.equal((await h.api('GET', '/admin/notifications/resume')).body.status, 'processing');
  assert.ok((await activityEvents(h, 'resume')).includes('fanout_retry_scheduled'));

  boom = false;
  await h.advance(1000); // first fan-out backoff
  ev = h.db.get(`SELECT status FROM events WHERE transaction_id = 'resume'`);
  assert.equal(ev.status, 'processed');
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM notifications').n, 5);
  assert.equal(h.provider.delivered.length, 5);
  subs.byExternal = original;
});

test('RELIABILITY: fan-out gives up after bounded attempts and says so', async (t) => {
  const h = await setup(2);
  t.after(() => h.close());
  const subs = h.ctx.subscribers;
  subs.byExternal = () => { throw new Error('permanent outage'); };
  await h.trigger('doomed', 'grade-alerts', h.explicit('student_001'), {});
  for (let i = 0; i < 8; i += 1) await h.advance(61000);
  const ev = h.db.get(`SELECT status, attempts, last_error FROM events WHERE transaction_id = 'doomed'`);
  assert.equal(ev.status, 'failed');
  assert.equal(ev.attempts, h.ctx.config.fanoutMaxAttempts);
  const status = await h.api('GET', '/admin/notifications/doomed');
  assert.equal(status.body.status, 'failed');
  assert.match(status.body.lastError, /permanent outage/);
  assert.ok((await activityEvents(h, 'doomed')).includes('fanout_failed'));
});

test('RELIABILITY: replaying a fan-out chunk creates no duplicate notifications', async (t) => {
  const h = await setup(3);
  t.after(() => h.close());
  await h.trigger('replay', 'grade-alerts', h.explicit('student_001', 'student_002', 'student_003'), {});
  await h.tick();
  // Force the recipients back to pending and the event back to processing, as after a crash.
  h.db.run(`UPDATE event_recipients SET state = 'pending'`);
  h.db.run(`UPDATE events SET status = 'processing', updated_at = ?`, h.clock.now() - 1);
  await h.advance(100000);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM notifications').n, 3);
  assert.equal(h.provider.delivered.length, 3);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM jobs').n, 6);
});

test('RELIABILITY: a preference-lookup failure is a visible, retried failure; recovery delivers once', async (t) => {
  const h = await setup(1);
  t.after(() => h.close());
  const subs = h.ctx.subscribers;
  const original = subs.resolve;
  let fail = 2;
  subs.resolve = (...args) => {
    if (fail > 0) { fail -= 1; throw new Error('preferences store unavailable'); }
    return original(...args);
  };
  await h.trigger('prefs-down', 'grade-alerts', h.explicit('student_001'), { course: 'A', grade: '1' });
  await h.tick();
  const job = h.db.get(`SELECT status, attempts, last_error FROM jobs WHERE step_type = 'email'`);
  assert.equal(job.status, 'retrying');
  assert.match(job.last_error, /unavailable/);
  assert.equal(h.provider.calls.length, 0, 'nothing is sent while preferences cannot be checked');
  await h.advance(1000);
  await h.advance(5000);
  assert.equal(h.provider.delivered.length, 1);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM notifications').n, 1);
  const events = await activityEvents(h, 'prefs-down');
  assert.equal(events.filter((e) => e === 'retry_scheduled').length, 2);
  subs.resolve = original;
});

test('RELIABILITY: re-running an in-app job updates the same message instead of adding another', async (t) => {
  const h = await setup(1);
  t.after(() => h.close());
  await h.trigger('inapp-dup', 'grade-alerts', h.explicit('student_001'), { course: 'A', grade: '1' });
  await h.tick();
  h.db.run(`UPDATE jobs SET status = 'running', locked_at = ? WHERE step_type = 'in-app'`, h.clock.now() - 1);
  await h.advance(91000);
  assert.equal(h.db.get(`SELECT COUNT(*) AS n FROM messages WHERE channel = 'in-app'`).n, 1);
  assert.equal(h.db.get(`SELECT COUNT(*) AS n FROM messages WHERE channel = 'email'`).n, 1);
});

test('RELIABILITY: a worker pass that hits a database error surfaces it and the next pass recovers', async (t) => {
  const h = await setup(1);
  t.after(() => h.close());
  await h.trigger('db-flaky', 'grade-alerts', h.explicit('student_001'), {});
  const original = h.ctx.ingest.processDueEvents;
  h.ctx.ingest.processDueEvents = () => { throw new Error('SQLITE_BUSY'); };
  await assert.rejects(h.tick(), /SQLITE_BUSY/);
  assert.equal(h.provider.calls.length, 0);
  h.ctx.ingest.processDueEvents = original;
  await h.tick();
  assert.equal(h.provider.delivered.length, 1, 'the accepted event was durable and is processed after recovery');
});

test('RELIABILITY: a job that exhausts its budget through repeated crashes is failed, not looped forever', async (t) => {
  const h = await setup(1);
  t.after(() => h.close());
  await h.trigger('loop', 'grade-alerts', h.explicit('student_001'), {});
  await h.tick();
  const job = h.db.get(`SELECT id FROM jobs WHERE step_type = 'email'`);
  h.db.run(`UPDATE messages SET idempotency_key = 'other' WHERE channel = 'email'`);
  h.db.run(`UPDATE jobs SET status = 'running', attempts = max_attempts, locked_at = ? WHERE id = ?`, h.clock.now() - 1, job.id);
  await h.advance(91000);
  assert.equal(h.db.get('SELECT status FROM jobs WHERE id = ?', job.id).status, 'failed');
  assert.ok((await activityEvents(h, 'loop')).includes('delivery_failed'));
});

test('OBSERVABILITY: activity log traces event -> notification -> attempt -> result', async (t) => {
  const h = await setup(1);
  t.after(() => h.close());
  await h.trigger('trace', 'grade-alerts', h.explicit('student_001'), { course: 'A', grade: '1' });
  await h.tick();
  assert.deepEqual(await activityEvents(h, 'trace'), ['event_submitted', 'recipients_resolved', 'email_sent', 'inapp_created']);
  const row = h.db.get(`SELECT notification_id, job_id, attempt FROM activity_log WHERE event = 'email_sent'`);
  assert.ok(row.notification_id && row.job_id && row.attempt === 1);
});
