'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, seedStandard, addStudents, activityEvents, FakeEmailProvider } = require('./helpers');

const emailJob = (h) => h.db.get(`SELECT * FROM jobs WHERE step_type='email' ORDER BY id LIMIT 1`);
const counts = (h) => ({
  events: h.db.get('SELECT COUNT(*) AS n FROM events').n,
  notifications: h.db.get('SELECT COUNT(*) AS n FROM notifications').n,
  emailMessages: h.db.get(`SELECT COUNT(*) AS n FROM messages WHERE channel='email'`).n,
  inAppMessages: h.db.get(`SELECT COUNT(*) AS n FROM messages WHERE channel='in-app'`).n,
});

test('KT3: a failed send is retried and succeeds without creating duplicates', async (t) => {
  const provider = new FakeEmailProvider(['fail-500', 'ok']);
  const h = await createHarness({ provider });
  t.after(() => h.close());
  await seedStandard(h);
  await addStudents(h, 1);

  await h.trigger('kt3-1', 'grade-alerts', h.explicit('student_001'), { course: 'CS101', grade: '91' });
  await h.tick();

  // Attempt 1 failed: job is RETRYING, nothing recorded as delivered, notification still the same one.
  let job = emailJob(h);
  assert.equal(job.status, 'retrying');
  assert.equal(job.attempts, 1);
  assert.match(job.last_error, /500/);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.delivered.length, 0);
  assert.equal(counts(h).emailMessages, 0);
  assert.equal(counts(h).inAppMessages, 0, 'chain order is preserved: in-app waits for the email step');
  const before = counts(h);

  // Too early: backoff (1s) has not elapsed, so no new attempt.
  await h.advance(500);
  assert.equal(provider.calls.length, 1);

  // Backoff elapsed: the retry runs and succeeds.
  await h.advance(600);
  job = emailJob(h);
  assert.equal(job.status, 'completed');
  assert.equal(job.attempts, 2);
  assert.equal(provider.calls.length, 2);
  assert.equal(provider.delivered.length, 1, 'recipient got exactly one email');

  // Same logical notification and the same idempotency key on both attempts.
  assert.equal(provider.calls[0].idempotencyKey, provider.calls[1].idempotencyKey);
  assert.equal(provider.calls[0].idempotencyKey, job.idempotency_key);
  const after = counts(h);
  assert.equal(after.notifications, before.notifications, 'retry created no new notification');
  assert.equal(after.events, before.events);
  assert.equal(after.emailMessages, 1);
  assert.equal(after.inAppMessages, 1, 'chain continued after the retry succeeded');

  // Attempts, notification and provider result are separate records.
  const attempts = h.db.all('SELECT attempt_no, status, error, provider_message_id FROM delivery_attempts WHERE job_id = ? ORDER BY attempt_no', job.id);
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts.map((a) => a.status), ['failed', 'success']);
  assert.match(attempts[0].error, /500/);
  assert.equal(attempts[1].provider_message_id, 'prov_1');
  const msg = h.db.get(`SELECT * FROM messages WHERE channel='email'`);
  assert.equal(msg.provider_message_id, 'prov_1');
  assert.equal(msg.idempotency_key, job.idempotency_key);

  // Activity log reads FAILED (attempt 1) -> RETRYING -> SENT (attempt 2).
  const log = await h.api('GET', '/admin/activity?transactionId=kt3-1&limit=100');
  const trail = log.body.events.filter((e) => ['email_failed', 'retry_scheduled', 'email_sent'].includes(e.event));
  assert.deepEqual(trail.map((e) => [e.event, e.attempt ?? null]), [['email_failed', 1], ['retry_scheduled', 1], ['email_sent', 2]]);

  const status = await h.api('GET', '/admin/notifications/kt3-1');
  assert.equal(status.body.status, 'delivered');
  assert.equal(status.body.recipientStats.emailSent, 1);
});

test('KT3: provider accepted the mail but the response failed; retry reuses the key and nothing is sent twice', async (t) => {
  const provider = new FakeEmailProvider(['fail-after-send', 'ok']);
  const h = await createHarness({ provider });
  t.after(() => h.close());
  await seedStandard(h);
  await addStudents(h, 1);
  await h.trigger('kt3-ambiguous', 'grade-alerts', h.explicit('student_001'), { course: 'CS101', grade: '50' });
  await h.tick();
  assert.equal(emailJob(h).status, 'retrying');
  await h.advance(1000);
  assert.equal(provider.calls.length, 2, 'two attempts reached the provider');
  assert.equal(provider.delivered.length, 1, 'the provider de-duplicated by idempotency key');
  assert.equal(counts(h).emailMessages, 1);
  assert.equal(emailJob(h).status, 'completed');
});

test('KT3: a failure before anything was sent retries to exactly one delivery even with a provider that cannot de-duplicate', async (t) => {
  const provider = new FakeEmailProvider(['fail-500', 'fail-500', 'ok'], { dedupByKey: false });
  const h = await createHarness({ provider });
  t.after(() => h.close());
  await seedStandard(h);
  await addStudents(h, 1);
  await h.trigger('kt3-naive', 'grade-alerts', h.explicit('student_001'), { course: 'X', grade: '1' });
  await h.tick();
  await h.advance(1000); // 1s backoff after attempt 1
  assert.equal(emailJob(h).status, 'retrying');
  await h.advance(4999);
  assert.equal(provider.calls.length, 2, '5s backoff after attempt 2 has not elapsed yet');
  await h.advance(1);
  assert.equal(provider.calls.length, 3);
  assert.equal(provider.delivered.length, 1);
  assert.equal(counts(h).emailMessages, 1);
});

test('KT3: retries are bounded; after the last attempt the email is failed and the chain moves on', async (t) => {
  const provider = new FakeEmailProvider(['fail-500', 'fail-500', 'fail-500', 'ok']);
  const h = await createHarness({ provider });
  t.after(() => h.close());
  await seedStandard(h);
  await addStudents(h, 1);
  await h.trigger('kt3-exhaust', 'grade-alerts', h.explicit('student_001'), { course: 'X', grade: '1' });
  await h.tick();
  await h.advance(1000);
  await h.advance(5000);
  const job = emailJob(h);
  assert.equal(job.status, 'failed');
  assert.equal(job.attempts, 3);
  await h.advance(60000);
  await h.advance(60000);
  assert.equal(provider.calls.length, 3, 'no fourth attempt');
  assert.equal(provider.delivered.length, 0);

  const n = h.db.get('SELECT * FROM notifications');
  assert.equal(n.delivery_email, 'failed');
  assert.equal(n.delivery_in_app, 'sent', 'in-app still delivered after the email step gave up');
  assert.equal(n.status, 'partially_sent');
  const events = await activityEvents(h, 'kt3-exhaust');
  assert.ok(events.includes('delivery_failed'));
  const status = await h.api('GET', '/admin/notifications/kt3-exhaust');
  assert.equal(status.body.recipientStats.emailFailed, 1);
  assert.equal(status.body.status, 'partially_sent');
});

test('KT3: a permanent provider error is not retried', async (t) => {
  const provider = new FakeEmailProvider(['fail-permanent', 'ok']);
  const h = await createHarness({ provider });
  t.after(() => h.close());
  await seedStandard(h);
  await addStudents(h, 1);
  await h.trigger('kt3-perm', 'grade-alerts', h.explicit('student_001'), { course: 'X', grade: '1' });
  await h.tick();
  await h.advance(60000);
  assert.equal(provider.calls.length, 1);
  const job = emailJob(h);
  assert.equal(job.status, 'failed');
  assert.equal(job.attempts, 1);
  const attempt = h.db.get('SELECT transient FROM delivery_attempts WHERE job_id = ?', job.id);
  assert.equal(attempt.transient, 0);
});

test('KT3: re-executing an already delivered job (crash before status was saved) does not send or store a second copy', async (t) => {
  const provider = new FakeEmailProvider();
  const h = await createHarness({ provider });
  t.after(() => h.close());
  await seedStandard(h);
  await addStudents(h, 1);
  await h.trigger('kt3-crash', 'grade-alerts', h.explicit('student_001'), { course: 'X', grade: '1' });
  await h.tick();
  assert.equal(provider.calls.length, 1);

  // Simulate a worker that died after the send: job looks interrupted and its lock expires.
  const job = emailJob(h);
  h.db.run(`UPDATE jobs SET status = 'running', locked_at = ?, completed_at = NULL WHERE id = ?`, h.clock.now() - 1, job.id);
  h.db.run(`DELETE FROM jobs WHERE step_type = 'in-app'`); // keep the scenario to the email step
  await h.advance(91000);

  assert.equal(provider.calls.length, 1, 'provider was not called again');
  assert.equal(counts(h).emailMessages, 1);
  assert.equal(emailJob(h).status, 'completed');
  assert.ok((await activityEvents(h, 'kt3-crash')).includes('email_deduplicated'));
});

test('KT3: the message table itself refuses a duplicate logical message', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seedStandard(h);
  await addStudents(h, 1);
  await h.trigger('kt3-db', 'grade-alerts', h.explicit('student_001'), { course: 'X', grade: '1' });
  await h.tick();
  const m = h.db.get(`SELECT * FROM messages WHERE channel='email'`);
  assert.throws(() => h.db.run(
    `INSERT INTO messages (notification_id, job_id, subscriber_id, channel, content, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, 'email', 'dup', ?, 1, 1)`, m.notification_id, m.job_id, m.subscriber_id, m.idempotency_key,
  ), /UNIQUE constraint failed/);
});
