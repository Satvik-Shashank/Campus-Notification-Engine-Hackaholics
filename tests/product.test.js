'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./helpers');
const { seed } = require('../src/seed');

async function setup() {
  const h = await createHarness();
  await seed(h.engine, { history: false });
  return h;
}

test('PRODUCT: categories, priority and actions flow from the workflow into the student feed', async (t) => {
  const h = await setup();
  t.after(() => h.close());
  await h.trigger('p-1', 'class-cancellation', h.explicit('student_001'), { course: 'CS302', title: 'CS302 lecture cancelled', summary: 'Made up on Saturday.' });
  await h.trigger('p-2', 'campus-closure', { type: 'broadcast' }, { title: 'Campus closed today', summary: 'Heavy rain.' });
  await h.tick();
  const me = await h.asUser('student_001');
  const feed = (await me('GET', '/inbox/feed')).body;
  const cls = feed.items.find((i) => i.title === 'CS302 lecture cancelled');
  assert.equal(cls.category, 'academic');
  assert.equal(cls.priority, 'normal');
  assert.deepEqual(cls.primaryAction, { label: 'View course page', url: '/courses/CS302' });
  const closure = feed.items.find((i) => i.title === 'Campus closed today');
  assert.equal(closure.priority, 'critical');
  assert.equal(feed.counts.criticalUnread, 1);

  assert.equal((await me('GET', '/inbox/feed?category=academic')).body.items.length, 1);
  assert.equal((await me('GET', '/inbox/feed?priority=critical')).body.items.length, 1);
  assert.equal((await me('GET', '/inbox/feed?q=closed')).body.items.length, 1);
  assert.equal((await me('GET', '/inbox/feed?category=nope')).status, 400);

  const detail = (await me('GET', `/inbox/feed/${closure.messageId}`)).body;
  assert.match(detail.reason, /everyone at the university/);
  assert.match(detail.reason, /critical/i);
  const other = await h.asUser('CSE25103');
  assert.equal((await other('GET', `/inbox/feed/${cls.messageId}`)).status, 404, 'cannot open someone else’s notification');
});

test('PRODUCT: read, click and read-all persist; engagement is recorded', async (t) => {
  const h = await setup();
  t.after(() => h.close());
  for (let i = 0; i < 3; i += 1) await h.trigger(`r-${i}`, 'transport-update', h.explicit('student_001'), { route: String(i), title: `Route ${i} delayed`, summary: 'x' });
  await h.tick();
  const me = await h.asUser('student_001');
  const items = (await me('GET', '/inbox/feed')).body.items;
  await me('POST', `/inbox/feed/${items[0].messageId}/click`);
  const after = (await me('GET', '/inbox/feed')).body;
  assert.equal(after.counts.unread, 2);
  assert.ok(after.items.find((i) => i.messageId === items[0].messageId).clickedAt);
  await me('POST', `/inbox/feed/${items[0].messageId}/read`, { read: false });
  assert.equal((await me('GET', '/inbox/feed')).body.counts.unread, 3);
  assert.equal((await me('POST', '/inbox/read-all', {})).body.updated, 3);
  assert.equal((await me('GET', '/inbox/feed')).body.counts.unread, 0);
});

test('PRODUCT: category preferences change delivery (workflow > category > global)', async (t) => {
  const h = await setup();
  t.after(() => h.close());
  const me = await h.asUser('student_001');
  assert.equal((await me('PATCH', '/inbox/preferences/categories/academic', { email: false })).status, 200);
  assert.equal((await me('PATCH', '/inbox/preferences/categories/nope', { email: false })).status, 404);
  await h.trigger('c-1', 'class-cancellation', h.explicit('student_001'), { course: 'CS302', title: 'A', summary: 'a' });
  await h.trigger('c-2', 'fee-reminder', h.explicit('student_001'), { term: 'T', title: 'B', summary: 'b' });
  await h.trigger('c-3', 'campus-closure', h.explicit('student_001'), { title: 'C', summary: 'c' });
  await h.tick();
  const emailed = h.provider.delivered.map((d) => d.subject).sort();
  assert.deepEqual(emailed, ['B', 'C'], 'academic email muted; administrative and critical still emailed');
  assert.equal((await me('GET', '/inbox/feed')).body.items.length, 3, 'all three still in-app');
  assert.deepEqual((await me('GET', '/inbox/preferences')).body.categories.academic, { email: false });
});

test('PRODUCT: topics can be followed and unfollowed; assigned groups cannot', async (t) => {
  const h = await setup();
  t.after(() => h.close());
  const me = await h.asUser('student_001');
  const topics = (await me('GET', '/inbox/topics')).body.topics;
  const robotics = topics.find((x) => x.key === 'club:robotics');
  assert.equal(robotics.followable, true);
  await h.http('POST', '/inbox/topics/club:robotics/follow', { token: await h.login('student_001') });
  await h.trigger('t-1', 'club-announcement', { type: 'topic', topic: 'club:robotics' }, { club: 'robotics', eventId: 'r1', title: 'Robot build night', summary: 'Friday.' });
  await h.tick();
  assert.ok((await me('GET', '/inbox/feed?q=Robot')).body.items.length === 1, 'following delivers');
  await h.http('DELETE', '/inbox/topics/club:robotics/follow', { token: await h.login('student_001') });
  assert.equal((await me('GET', '/inbox/topics/club:robotics')).body.following, false);
  const assigned = await h.http('POST', '/inbox/topics/course:CS301/follow', { token: await h.login('student_001') });
  assert.equal(assigned.status, 409);
  assert.equal((await h.http('POST', '/inbox/topics/nope/follow', { token: await h.login('student_001') })).status, 404);
});

test('PRODUCT: audience estimate and multi-group targeting deliver to the union exactly once', async (t) => {
  const h = await setup();
  t.after(() => h.close());
  const a = (await h.api('POST', '/admin/audiences/estimate', { topics: ['course:CS301'] })).body.students;
  const b = (await h.api('POST', '/admin/audiences/estimate', { topics: ['club:coding'] })).body.students;
  const both = (await h.api('POST', '/admin/audiences/estimate', { topics: ['course:CS301', 'club:coding'] })).body.students;
  assert.ok(both <= a + b && both >= Math.max(a, b), 'union, not sum');
  const r = await h.trigger('u-1', 'university-event', { type: 'topic', topics: ['course:CS301', 'club:coding'] }, { eventId: 'e', title: 'Talk', summary: 's' });
  assert.equal(r.body.recipientCount, both);
  await h.tick();
  assert.equal(h.db.get(`SELECT COUNT(*) AS n FROM notifications WHERE transaction_id = 'u-1'`).n, both);
  assert.equal((await h.api('GET', '/admin/audiences')).body.everyone, 180);
  assert.equal((await h.trigger('u-2', 'university-event', { type: 'topic', topics: [] }, { title: 'x' })).status, 400);
});
