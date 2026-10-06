'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, seedStandard, addStudents, activityEvents } = require('./helpers');

test('KT2: a user who muted email receives the notification in-app only', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seedStandard(h);
  await addStudents(h, 2);

  const alice = await h.asUser('student_001');
  const mute = await alice('PATCH', '/inbox/preferences', { email: false });
  assert.equal(mute.status, 200);
  assert.deepEqual(mute.body.global, { email: false, inApp: true });

  const r = await h.trigger('kt2-1', 'grade-alerts', h.explicit('student_001', 'student_002'), { course: 'CS101', grade: '89' });
  assert.equal(r.status, 202);
  await h.tick();

  // EXPECTED: in-app delivered for the muted user, email NOT sent to them.
  assert.equal(h.provider.calls.filter((c) => c.to === 'student_001@campus.example').length, 0, 'muted user got no email attempt');
  const inbox = await alice('GET', '/inbox/notifications');
  assert.equal(inbox.body.total, 1);
  assert.match(inbox.body.notifications[0].content, /CS101: 89/);

  // The un-muted student is unaffected: email AND in-app.
  assert.equal(h.provider.delivered.filter((d) => d.to === 'student_002@campus.example').length, 1);
  const bob = await h.asUser('student_002');
  assert.equal((await bob('GET', '/inbox/notifications')).body.total, 1);

  // Skipped, not failed or retried.
  const n = h.db.get(`SELECT n.* FROM notifications n JOIN subscribers s ON s.id = n.subscriber_id WHERE s.external_id = 'student_001'`);
  assert.equal(n.delivery_email, 'skipped');
  assert.equal(n.delivery_in_app, 'sent');
  assert.equal(n.status, 'sent');
  assert.equal(h.db.get(`SELECT COUNT(*) AS n FROM delivery_attempts WHERE channel='email' AND job_id IN
    (SELECT id FROM jobs WHERE subscriber_id = ?)`, n.subscriber_id).n, 0, 'no email attempt row for the muted user');

  const events = await h.api('GET', '/admin/activity?transactionId=kt2-1&subscriberId=student_001');
  const byEvent = Object.fromEntries(events.body.events.map((e) => [e.event, e]));
  assert.equal(byEvent.step_skipped.status, 'skipped');
  assert.equal(byEvent.step_skipped.stepType, 'email');
  assert.equal(byEvent.inapp_created.status, 'success');
  assert.ok(!('email_sent' in byEvent));

  const status = await h.api('GET', '/admin/notifications/kt2-1');
  assert.equal(status.body.recipientStats.emailSkipped, 1);
  assert.equal(status.body.recipientStats.emailSent, 1);
  assert.equal(status.body.recipientStats.inAppSent, 2);
  assert.equal(status.body.status, 'delivered');
});

test('KT2: preferences are evaluated when the job runs, not when the event is triggered', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seedStandard(h);
  await addStudents(h, 1);
  await h.trigger('late-mute', 'grade-alerts', h.explicit('student_001'), { course: 'CS101', grade: '70' });
  // Not processed yet; the student mutes email now.
  const user = await h.asUser('student_001');
  await user('PATCH', '/inbox/preferences', { email: false });
  await h.tick();
  assert.equal(h.provider.calls.length, 0);
  assert.ok((await activityEvents(h, 'late-mute')).includes('step_skipped'));
});

test('KT2: workflow-level override beats the global preference (both directions)', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seedStandard(h);
  await addStudents(h, 1);
  const user = await h.asUser('student_001');

  await user('PATCH', '/inbox/preferences', { email: false });
  const on = await user('PATCH', '/inbox/preferences/grade-alerts', { email: true });
  assert.equal(on.status, 200);
  await h.trigger('ov-1', 'grade-alerts', h.explicit('student_001'), { course: 'A', grade: '1' });
  await h.tick();
  assert.equal(h.provider.delivered.length, 1, 'workflow override re-enables email');

  await user('PATCH', '/inbox/preferences', { email: true });
  await user('PATCH', '/inbox/preferences/grade-alerts', { email: false });
  await h.trigger('ov-2', 'grade-alerts', h.explicit('student_001'), { course: 'A', grade: '2' });
  await h.tick();
  assert.equal(h.provider.delivered.length, 1, 'workflow override mutes email despite global on');

  const prefs = await user('GET', '/inbox/preferences');
  assert.deepEqual(prefs.body.workflows['grade-alerts'], { email: false });
  assert.deepEqual(prefs.body.global, { email: true, inApp: true });
});

test('KT2: muting both channels delivers nothing, and critical workflows ignore mutes', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seedStandard(h);
  await addStudents(h, 1);
  const user = await h.asUser('student_001');
  await user('PATCH', '/inbox/preferences', { email: false, inApp: false });

  await h.trigger('muted-all', 'grade-alerts', h.explicit('student_001'), { course: 'A', grade: '1' });
  await h.tick();
  assert.equal(h.provider.calls.length, 0);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM messages').n, 0);

  await h.trigger('alarm', 'emergency-alert', h.explicit('student_001'), { title: 'Campus closed' });
  await h.tick();
  assert.equal(h.provider.delivered.length, 1, 'critical workflow reaches a fully muted user by email');
  assert.equal((await user('GET', '/inbox/notifications')).body.total, 1, 'and in-app');
});

test('KT2: preference input is validated', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seedStandard(h);
  await addStudents(h, 1);
  const user = await h.asUser('student_001');
  assert.equal((await user('PATCH', '/inbox/preferences', {})).status, 400);
  assert.equal((await user('PATCH', '/inbox/preferences', { email: 'no' })).status, 400);
  assert.equal((await user('PATCH', '/inbox/preferences/unknown-workflow', { email: false })).status, 404);
});
