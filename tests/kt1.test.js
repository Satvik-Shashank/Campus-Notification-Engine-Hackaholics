'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, seedStandard, addStudents, activityEvents } = require('./helpers');

test('KT1: ten events within five minutes arrive as a single digest', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seedStandard(h);
  await addStudents(h, 1);
  const to = h.explicit('student_001');

  // Ten related events, 20s apart (200s total, inside the 300s window).
  for (let i = 1; i <= 10; i += 1) {
    const r = await h.trigger(`room-change-${i}`, 'exam-digest', to, { exam: 'CS101', room: `H${100 + i}` });
    assert.equal(r.status, 202);
    await h.advance(20000);
    // While the window is open nothing may be delivered.
    assert.equal(h.provider.calls.length, 0, `no email may be sent while window is open (after event ${i})`);
  }

  // Exactly one DELAYED master exists, nine events are merged into it.
  assert.equal(h.db.get(`SELECT COUNT(*) AS n FROM jobs WHERE step_type='digest' AND status='delayed'`).n, 1);
  assert.equal(h.db.get(`SELECT COUNT(*) AS n FROM jobs WHERE step_type='digest' AND status='merged'`).n, 9);
  assert.equal(h.db.get(`SELECT COUNT(*) AS n FROM messages`).n, 0);

  // Close the window (300s after the first event).
  await h.advance(100001);

  assert.equal(h.provider.calls.length, 1, 'one provider call for the whole burst');
  assert.equal(h.provider.delivered.length, 1);
  const email = h.provider.delivered[0];
  for (let i = 1; i <= 10; i += 1) assert.match(email.body, new RegExp(`H${100 + i}\\b`), `digest email lists event ${i}`);
  assert.match(email.subject, /^10 updates/);

  assert.equal(h.db.get(`SELECT COUNT(*) AS n FROM messages WHERE channel='email'`).n, 1);
  assert.equal(h.db.get(`SELECT COUNT(*) AS n FROM messages WHERE channel='in-app'`).n, 1);

  // Ten logical notifications exist (one per event), but only the master delivered.
  const states = h.db.all(`SELECT status, COUNT(*) AS n FROM notifications GROUP BY status`);
  assert.deepEqual(Object.fromEntries(states.map((s) => [s.status, s.n])), { sent: 1, digested: 9 });

  // The user sees one in-app item containing all ten events.
  const user = await h.asUser('student_001');
  const inbox = await user('GET', '/inbox/notifications');
  assert.equal(inbox.body.total, 1);
  for (let i = 1; i <= 10; i += 1) assert.match(inbox.body.notifications[0].content, new RegExp(`H${100 + i}\\b`));

  // Activity trail on the first event shows master creation, the digest closing, then the email.
  const first = await activityEvents(h, 'room-change-1');
  assert.deepEqual(first.filter((e) => e.startsWith('digest') || e === 'email_sent' || e === 'inapp_created'),
    ['digest_master_created', 'digest_emitted', 'email_sent', 'inapp_created']);
  const last = await activityEvents(h, 'room-change-10');
  assert.ok(last.includes('digest_merged'));
  assert.ok(!last.includes('email_sent'));
});

test('KT1: the database refuses a second delayed digest master', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seedStandard(h);
  await addStudents(h, 1);
  await h.trigger('e1', 'exam-digest', h.explicit('student_001'), { exam: 'CS101', room: 'A' });
  await h.tick();

  const master = h.db.get(`SELECT * FROM jobs WHERE step_type='digest' AND status='delayed'`);
  assert.ok(master);
  // Fabricate a competing master by hand; the partial unique index must reject it.
  await h.trigger('e2', 'exam-digest', h.explicit('student_001'), { exam: 'OTHER', room: 'B' });
  await h.tick();
  const other = h.db.get(`SELECT * FROM jobs WHERE step_type='digest' AND status='delayed' AND digest_value='OTHER'`);
  assert.ok(other, 'a different digest value gets its own master');
  assert.throws(
    () => h.db.run(`UPDATE jobs SET digest_value='CS101' WHERE id = ?`, other.id),
    /UNIQUE constraint failed/,
  );
});

test('KT1: digests are per subscriber and per digest value; a later event opens a new window', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seedStandard(h);
  await addStudents(h, 2);

  await h.trigger('a1', 'exam-digest', h.explicit('student_001', 'student_002'), { exam: 'CS101', room: 'A1' });
  await h.trigger('a2', 'exam-digest', h.explicit('student_001'), { exam: 'MATH201', room: 'B1' });
  await h.tick();
  await h.advance(300000);

  // student_001: two digests (two exams); student_002: one.
  assert.equal(h.provider.delivered.filter((d) => d.to === 'student_001@campus.example').length, 2);
  assert.equal(h.provider.delivered.filter((d) => d.to === 'student_002@campus.example').length, 1);

  // After the window closed, a new event starts a fresh digest instead of merging into the old one.
  await h.trigger('a3', 'exam-digest', h.explicit('student_002'), { exam: 'CS101', room: 'A2' });
  await h.tick();
  await h.advance(300000);
  assert.equal(h.provider.delivered.filter((d) => d.to === 'student_002@campus.example').length, 2);
});

test('KT1: an event that arrives after the window closed (before the worker ran) starts a new digest', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  await seedStandard(h);
  await addStudents(h, 1);
  await h.trigger('late-1', 'exam-digest', h.explicit('student_001'), { exam: 'CS101', room: 'A' });
  await h.tick();
  // Jump past the window WITHOUT ticking, then submit and process in one pass.
  h.clock.advance(301000);
  await h.trigger('late-2', 'exam-digest', h.explicit('student_001'), { exam: 'CS101', room: 'B' });
  await h.tick();
  assert.equal(h.provider.delivered.length, 1, 'the first window flushed on its own');
  assert.match(h.provider.delivered[0].body, /Room for CS101: A/);
  assert.doesNotMatch(h.provider.delivered[0].body, /: B/);
  await h.advance(300000);
  assert.equal(h.provider.delivered.length, 2);
});
