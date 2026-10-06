'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, seedStandard, addStudents, activityEvents } = require('./helpers');

const MIN = 60000;
const HOUR = 60 * MIN;

async function setup(students = 2) {
  const h = await createHarness();
  await seedStandard(h);
  await addStudents(h, students);
  return h;
}

test('FOCUS: normal notifications are held, a critical one bypasses, and a catch-up summary follows', async (t) => {
  const h = await setup();
  t.after(() => h.close());
  const user = await h.asUser('student_001');
  const to = h.explicit('student_001');

  const start = await user('POST', '/inbox/focus-mode/start', { duration: '2h' });
  assert.equal(start.status, 201);
  assert.equal((await user('GET', '/inbox/focus-mode/status')).body.active, true);

  // 3:05 room change, 3:10 confirmation (same exam), 3:15 grade: all non-critical -> held.
  await h.advance(5 * MIN);
  await h.trigger('f-room', 'exam-live', to, { exam: 'CS101', room: 'H123' });
  await h.advance(5 * MIN);
  await h.trigger('f-confirm', 'exam-live', to, { exam: 'CS101', room: 'H123', confirmed: true });
  await h.advance(5 * MIN);
  await h.trigger('f-grade', 'grade-alerts', to, { course: 'MATH', grade: '89' });
  await h.tick();

  assert.equal(h.provider.calls.length, 0, 'nothing emailed during focus');
  assert.equal((await user('GET', '/inbox/notifications')).body.total, 0, 'nothing in the inbox during focus');
  assert.equal((await user('GET', '/inbox/focus-mode/status')).body.heldCount, 3);
  assert.deepEqual(h.db.all(`SELECT DISTINCT status FROM notifications`).map((r) => r.status), ['held']);
  assert.ok((await activityEvents(h, 'f-room')).includes('step_deferred'));

  // 3:45 exam begins in 15 minutes: critical by the workflow rule -> delivered immediately.
  await h.advance(30 * MIN);
  await h.trigger('f-critical', 'exam-live', to, { exam: 'CS101', room: 'H123', minutesUntilExam: 15 });
  await h.tick();
  assert.equal(h.provider.delivered.length, 1, 'critical email delivered during focus');
  assert.match(h.provider.delivered[0].body, /H123/);
  assert.equal((await user('GET', '/inbox/notifications')).body.total, 1, 'critical in-app delivered during focus');
  assert.ok((await activityEvents(h, 'f-critical')).includes('focus_bypassed'));

  // Focus ends at 5:00 PM: one catch-up summary (email + in-app), not three replays.
  await h.advance(75 * MIN + 1);
  assert.equal((await user('GET', '/inbox/focus-mode/status')).body.active, false);
  assert.equal(h.provider.delivered.length, 2, 'critical + one summary email');
  const inbox = (await user('GET', '/inbox/notifications')).body;
  assert.equal(inbox.total, 2);

  const summary = (await user('GET', '/inbox/focus-mode/summary')).body;
  assert.equal(summary.sent, true);
  assert.equal(summary.heldCount, 3);
  const labels = summary.items.map((i) => i.label).sort();
  assert.deepEqual(labels, ['CS101'.replace(/^/, 'exam '), 'course MATH'].sort());
  const exam = summary.items.find((i) => i.label === 'exam CS101');
  assert.equal(exam.latest.confirmed, true, 'the confirmation is kept');
  assert.equal(exam.relatedEvents, 2, 'two held exam events were correlated into one item');
  // The room-only event is redundant once the critical alert already said "H123"; the confirmation is new info.
  assert.ok(summary.suppressed.acknowledged >= 1);
  assert.deepEqual(summary.interrupted.map((i) => i.label), ['exam CS101']);
  assert.match(summary.text, /course MATH: course: MATH, grade: 89/);
  assert.match(summary.text, /Already delivered immediately: exam CS101/);

  const summaryEmail = h.provider.delivered[1];
  assert.match(summaryEmail.subject, /^Focus catch-up: 2 changes/);
  assert.equal(summaryEmail.body, summary.text);

  // Held notifications are marked summarized, nothing is left deferred.
  assert.equal(h.db.get(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'deferred'`).n, 0);
  assert.equal(h.db.get(`SELECT COUNT(*) AS n FROM notifications WHERE status = 'summarized'`).n, 3);
});

test('FOCUS: related events are correlated and show what changed; exact repeats are suppressed', async (t) => {
  const h = await setup(1);
  t.after(() => h.close());
  const user = await h.asUser('student_001');
  await user('POST', '/inbox/focus-mode/start', { duration: '1h' });

  await h.trigger('c1', 'exam-live', h.explicit('student_001'), { exam: 'DBMS', room: 'A201' });
  await h.trigger('c2', 'exam-live', h.explicit('student_001'), { exam: 'DBMS', room: 'H123' });
  await h.trigger('c3', 'exam-live', h.explicit('student_001'), { exam: 'DBMS', room: 'H123' });
  await h.tick();
  await h.advance(HOUR);

  const summary = (await user('GET', '/inbox/focus-mode/summary')).body;
  assert.equal(summary.items.length, 1);
  assert.deepEqual(summary.items[0].changes, [{ field: 'room', from: 'A201', to: 'H123' }]);
  assert.equal(summary.items[0].relatedEvents, 3);
  assert.equal(summary.suppressed.duplicates, 1);
  assert.match(summary.text, /exam DBMS: room: A201 -> H123 \(3 related updates\)/);
  assert.equal(h.provider.delivered.length, 1, 'one summary instead of three emails');
});

test('FOCUS: an in-app message the user already saw suppresses the redundant held follow-up', async (t) => {
  const h = await setup(1);
  t.after(() => h.close());
  const user = await h.asUser('student_001');
  const to = h.explicit('student_001');

  // Before focus: the user receives and reads the room notice.
  await h.trigger('s0', 'exam-live', to, { exam: 'CS101', room: 'H123' });
  await h.tick();
  const msgs = (await user('GET', '/inbox/notifications')).body.notifications;
  assert.equal((await user('PATCH', `/inbox/notifications/${msgs[0].messageId}/seen`)).status, 200);
  await h.advance(MIN);

  await user('POST', '/inbox/focus-mode/start', { duration: '1h' });
  await h.advance(MIN);
  await h.trigger('s1', 'exam-live', to, { exam: 'CS101', room: 'H123' }); // same fact again
  await h.trigger('s2', 'grade-alerts', to, { course: 'CS101', grade: '70' });
  await h.tick();
  await h.advance(HOUR);

  // The seen message predates the session, so it does not count (acknowledgement must be during focus).
  const summary = (await user('GET', '/inbox/focus-mode/summary')).body;
  assert.equal(summary.items.length, 2);

  // Now acknowledge during a second session.
  await user('POST', '/inbox/focus-mode/start', { duration: '1h' });
  await h.advance(MIN);
  await h.trigger('s3', 'exam-live', to, { exam: 'CS101', room: 'H123', minutesUntilExam: 10 }); // critical, delivered
  await h.tick();
  const critical = (await user('GET', '/inbox/notifications')).body.notifications[0];
  await user('PATCH', `/inbox/notifications/${critical.messageId}/seen`);
  await h.advance(MIN);
  await h.trigger('s4', 'exam-live', to, { exam: 'CS101', room: 'H123' });
  await h.tick();
  await h.advance(HOUR);
  const second = (await user('GET', '/inbox/focus-mode/summary')).body;
  assert.equal(second.sent, false, 'everything held was already acknowledged, so no summary is sent');
  assert.equal(second.suppressed.acknowledged, 1);
  assert.equal(h.db.get(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'deferred'`).n, 0);
});

test('FOCUS: ends on its own at the deadline, and can be ended manually', async (t) => {
  const h = await setup(1);
  t.after(() => h.close());
  const user = await h.asUser('student_001');
  await user('POST', '/inbox/focus-mode/start', { duration: '30m' });
  await h.trigger('m1', 'grade-alerts', h.explicit('student_001'), { course: 'A', grade: '1' });
  await h.tick();
  assert.equal(h.provider.calls.length, 0);
  await h.advance(29 * MIN);
  assert.equal(h.provider.calls.length, 0, 'still inside the window');
  await h.advance(2 * MIN);
  assert.equal(h.provider.delivered.length, 1);

  await user('POST', '/inbox/focus-mode/start', { duration: '2h' });
  await h.trigger('m2', 'grade-alerts', h.explicit('student_001'), { course: 'B', grade: '2' });
  await h.tick();
  assert.equal(h.provider.delivered.length, 1);
  const ended = await user('POST', '/inbox/focus-mode/end');
  assert.equal(ended.status, 200);
  assert.equal(ended.body.summary.sent, true);
  await h.tick();
  assert.equal(h.provider.delivered.length, 2);
  assert.equal((await user('POST', '/inbox/focus-mode/end')).status, 404, 'nothing active to end');
});

test('FOCUS: the summary honours channel preferences (email muted -> in-app only)', async (t) => {
  const h = await setup(1);
  t.after(() => h.close());
  const user = await h.asUser('student_001');
  await user('PATCH', '/inbox/preferences', { email: false });
  await user('POST', '/inbox/focus-mode/start', { duration: '1h' });
  await h.trigger('p1', 'grade-alerts', h.explicit('student_001'), { course: 'A', grade: '1' });
  await h.tick();
  await h.advance(HOUR);
  assert.equal(h.provider.calls.length, 0);
  assert.equal((await user('GET', '/inbox/notifications')).body.total, 1);
});

test('FOCUS: critical workflows and event-level priority bypass focus; other users are unaffected', async (t) => {
  const h = await setup(2);
  t.after(() => h.close());
  const alice = await h.asUser('student_001');
  await alice('POST', '/inbox/focus-mode/start', { duration: '1h' });

  await h.trigger('b1', 'emergency-alert', h.explicit('student_001', 'student_002'), { title: 'Fire drill' });
  await h.trigger('b2', 'grade-alerts', h.explicit('student_001', 'student_002'), { course: 'A', grade: '1' }, { priority: 'critical' });
  await h.trigger('b3', 'grade-alerts', h.explicit('student_001', 'student_002'), { course: 'B', grade: '2' });
  await h.tick();

  const forAlice = h.provider.delivered.filter((d) => d.to === 'student_001@campus.example').length;
  const forBob = h.provider.delivered.filter((d) => d.to === 'student_002@campus.example').length;
  assert.equal(forAlice, 2, 'alert + priority=critical delivered, normal held');
  assert.equal(forBob, 3, 'a user without focus mode gets everything immediately');
});

test('FOCUS: input validation and state rules', async (t) => {
  const h = await setup(2);
  t.after(() => h.close());
  const user = await h.asUser('student_001');
  assert.equal((await user('POST', '/inbox/focus-mode/start', {})).status, 400);
  assert.equal((await user('POST', '/inbox/focus-mode/start', { duration: 'soon' })).status, 400);
  assert.equal((await user('POST', '/inbox/focus-mode/start', { duration: '0m' })).status, 400);
  assert.equal((await user('POST', '/inbox/focus-mode/start', { duration: '25h' })).status, 400, 'above FOCUS_MODE_MAX_HOURS');
  assert.equal((await user('POST', '/inbox/focus-mode/start', { duration: 90 })).status, 201, 'plain minutes accepted');
  assert.equal((await user('POST', '/inbox/focus-mode/start', { duration: '1h' })).status, 409);
  assert.equal((await user('GET', '/inbox/focus-mode/summary?sessionId=abc')).status, 400);

  const other = await h.asUser('student_002');
  assert.equal((await other('GET', '/inbox/focus-mode/status')).body.active, false, 'sessions are per user');
  assert.equal((await other('GET', '/inbox/focus-mode/summary')).status, 404);
  assert.equal((await h.http('GET', '/inbox/focus-mode/status', {})).status, 401);
});

test('FOCUS: users who never use it see no change in behaviour (digest and retry still work)', async (t) => {
  const h = await setup(1);
  t.after(() => h.close());
  await h.trigger('n1', 'exam-digest', h.explicit('student_001'), { exam: 'CS101', room: 'A' });
  await h.trigger('n2', 'exam-digest', h.explicit('student_001'), { exam: 'CS101', room: 'B' });
  await h.tick();
  await h.advance(300000);
  assert.equal(h.provider.delivered.length, 1);
  assert.match(h.provider.delivered[0].subject, /^2 updates/);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM held_events').n, 0);
});
