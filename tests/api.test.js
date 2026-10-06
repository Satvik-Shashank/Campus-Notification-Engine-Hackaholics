'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, seedStandard, addStudents, API_KEY } = require('./helpers');
const { signJwt } = require('../src/http/auth');
const { assertSafeForProduction, loadConfig } = require('../src/config');

async function setup(students = 2, opts) {
  const h = await createHarness(opts);
  await seedStandard(h);
  await addStudents(h, students);
  return h;
}

test('API: event validation returns 400 with a message', async (t) => {
  const h = await setup(1);
  t.after(() => h.close());
  const good = { transactionId: 't', workflowIdentifier: 'grade-alerts', to: h.explicit('student_001'), payload: { a: 1 } };
  const bad = [
    { ...good, transactionId: undefined },
    { ...good, workflowIdentifier: 'nope' },
    { ...good, workflowIdentifier: '__focus_summary__' },
    { ...good, to: { type: 'explicit', subscriberIds: [] } },
    { ...good, to: { type: 'explicit', subscriberIds: [1] } },
    { ...good, to: { type: 'explicit', subscriberIds: Array.from({ length: 101 }, (_, i) => `s${i}`) } },
    { ...good, to: { type: 'topic' } },
    { ...good, to: { type: 'carrier-pigeon' } },
    { ...good, payload: 'text' },
    { ...good, payload: [1] },
    { ...good, priority: 'urgent' },
  ];
  for (const body of bad) {
    const r = await h.api('POST', '/events/trigger', body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(r.body.error, 'BadRequest');
    assert.ok(r.body.message && r.body.timestamp);
  }
  const malformed = await h.http('POST', '/events/trigger', { rawBody: '{oops', key: API_KEY, headers: { 'content-type': 'application/json' } });
  assert.equal(malformed.status, 400);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM events').n, 0, 'nothing persisted for rejected requests');
  assert.equal((await h.api('POST', '/events/trigger', good)).status, 202);
});

test('API: API key is required for producer and admin routes', async (t) => {
  const h = await setup(1);
  t.after(() => h.close());
  const body = { transactionId: 'x', workflowIdentifier: 'grade-alerts', to: h.explicit('student_001'), payload: {} };
  for (const [method, path] of [['POST', '/events/trigger'], ['POST', '/events/trigger/bulk'], ['POST', '/events/trigger/broadcast'],
    ['DELETE', '/events/trigger/x'], ['GET', '/admin/activity'], ['GET', '/admin/notifications/x'],
    ['PUT', '/admin/workflows/w'], ['GET', '/admin/workflows'], ['PUT', '/admin/subscribers/s'], ['PUT', '/admin/topics/t/subscribers']]) {
    assert.equal((await h.http(method, path, { body })).status, 401, `${method} ${path} without key`);
    assert.equal((await h.http(method, path, { body, key: 'wrong' })).status, 401, `${method} ${path} wrong key`);
  }
  const subscriberToken = await h.login('student_001');
  assert.equal((await h.http('POST', '/events/trigger', { body, token: subscriberToken })).status, 401, 'a subscriber JWT is not an API key');
});

test('API: duplicate transactionId replays the first response and creates nothing new', async (t) => {
  const h = await setup(2);
  t.after(() => h.close());
  const send = () => h.trigger('dup-1', 'grade-alerts', h.explicit('student_001'), { course: 'A', grade: '1' });
  const first = await send();
  const second = await send();
  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.recipientCount, first.body.recipientCount);
  // Same id with a different body is still the same event (id wins; first payload kept).
  const third = await h.trigger('dup-1', 'grade-alerts', h.explicit('student_002'), { course: 'Z', grade: '9' });
  assert.equal(third.body.duplicate, true);
  await h.tick();
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM events').n, 1);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM notifications').n, 1);
  assert.equal(h.provider.delivered.length, 1);

  // Idempotency-Key header works as the transaction id.
  const viaHeader = await h.api('POST', '/events/trigger', { workflowIdentifier: 'grade-alerts', to: h.explicit('student_001'), payload: {} },
    { headers: { 'idempotency-key': 'hdr-1' } });
  assert.equal(viaHeader.body.transactionId, 'hdr-1');
});

test('API: concurrent duplicate submissions produce exactly one event', async (t) => {
  const h = await setup(1);
  t.after(() => h.close());
  const results = await Promise.all(Array.from({ length: 8 }, () =>
    h.trigger('race-1', 'grade-alerts', h.explicit('student_001'), { course: 'A', grade: '1' })));
  assert.ok(results.every((r) => r.status === 202));
  assert.equal(results.filter((r) => !r.body.duplicate).length, 1);
  await h.tick();
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM events').n, 1);
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM notifications').n, 1);
  assert.equal(h.provider.delivered.length, 1);
});

test('API: a transactionId can be reused after the 24h dedup window', async (t) => {
  const h = await setup(1);
  t.after(() => h.close());
  await h.trigger('reuse', 'grade-alerts', h.explicit('student_001'), { course: 'A', grade: '1' });
  await h.tick();
  await h.advance(24 * 3600 * 1000 + 1);
  const again = await h.trigger('reuse', 'grade-alerts', h.explicit('student_001'), { course: 'B', grade: '2' });
  assert.equal(again.status, 202);
  assert.notEqual(again.body.duplicate, true);
  await h.tick();
  assert.equal(h.provider.delivered.length, 2);
});

test('API: topics, broadcast, bulk and unknown subscribers', async (t) => {
  const h = await setup(4);
  t.after(() => h.close());
  const topic = await h.api('PUT', '/admin/topics/CS101/subscribers', { subscriberIds: ['student_001', 'student_002'] });
  assert.equal(topic.status, 200);
  assert.equal((await h.api('PUT', '/admin/topics/CS101/subscribers', { subscriberIds: ['ghost'] })).status, 400);

  const t1 = await h.trigger('topic-1', 'grade-alerts', { type: 'topic', topic: 'CS101' }, { course: 'A', grade: '1' });
  assert.equal(t1.body.recipientCount, 2);
  const b1 = await h.api('POST', '/events/trigger/broadcast', { transactionId: 'bc-1', workflowIdentifier: 'emergency-alert', payload: { title: 'Closed' } });
  assert.equal(b1.status, 202);
  assert.equal(b1.body.recipientCount, 4);
  await h.tick();
  assert.equal(h.provider.delivered.length, 2 + 4);

  const mixed = await h.trigger('ghosts', 'grade-alerts', h.explicit('student_003', 'ghost_1'), { course: 'A', grade: '1' });
  assert.equal(mixed.status, 202);
  await h.tick();
  const log = (await h.api('GET', '/admin/activity?transactionId=ghosts')).body.events;
  assert.ok(log.some((e) => e.event === 'recipient_skipped' && /ghost_1/.test(e.details)), 'unknown subscriber logged and skipped');
  // student_003 got the broadcast alert plus this event; the unknown id did not stop the known one.
  assert.equal(h.provider.delivered.filter((d) => d.to === 'student_003@campus.example').length, 2);

  const bulk = await h.api('POST', '/events/trigger/bulk', { events: [
    { transactionId: 'bk-1', workflowIdentifier: 'grade-alerts', to: h.explicit('student_001'), payload: {} },
    { transactionId: 'bk-2', workflowIdentifier: 'nope', to: h.explicit('student_001'), payload: {} },
  ] });
  assert.equal(bulk.status, 202);
  assert.deepEqual([bulk.body.acceptedCount, bulk.body.rejectedCount], [1, 1]);
  assert.equal(bulk.body.results[1].status, 'rejected');
  assert.equal((await h.api('POST', '/events/trigger/bulk', { events: [] })).status, 400);
  assert.equal((await h.api('POST', '/events/trigger/bulk', { events: [{ nope: 1 }] })).status, 400);
});

test('API: rate limit returns 429 with Retry-After semantics', async (t) => {
  const h = await setup(1, { config: { rateLimitPerMin: 3 } });
  t.after(() => h.close());
  const codes = [];
  for (let i = 0; i < 5; i += 1) codes.push((await h.trigger(`rl-${i}`, 'grade-alerts', h.explicit('student_001'), {})).status);
  assert.deepEqual(codes, [202, 202, 202, 429, 429]);
  await h.advance(61000);
  assert.equal((await h.trigger('rl-after', 'grade-alerts', h.explicit('student_001'), {})).status, 202);
});

test('API: cancel removes pending digest jobs and nothing is delivered', async (t) => {
  const h = await setup(1);
  t.after(() => h.close());
  const to = h.explicit('student_001');
  await h.trigger('cx-1', 'exam-digest', to, { exam: 'CS101', room: 'A' });
  await h.tick();
  const r = await h.api('DELETE', '/events/trigger/cx-1');
  assert.equal(r.status, 200);
  assert.ok(r.body.canceledJobCount >= 1);
  assert.equal((await h.api('DELETE', '/events/trigger/cx-1')).body.canceledJobCount, 0, 'idempotent');
  assert.equal((await h.api('DELETE', '/events/trigger/never-existed')).status, 404);
  await h.advance(300000);
  assert.equal(h.provider.calls.length, 0);
  assert.equal(h.db.get('SELECT status FROM notifications').status, 'canceled');
});

test('API: cancelling one event leaves other events merged in the same digest intact', async (t) => {
  const h = await setup(1);
  t.after(() => h.close());
  const to = h.explicit('student_001');
  await h.trigger('keep-1', 'exam-digest', to, { exam: 'CS101', room: 'MASTER' });
  await h.trigger('keep-2', 'exam-digest', to, { exam: 'CS101', room: 'MERGED' });
  await h.tick();
  await h.api('DELETE', '/events/trigger/keep-1'); // the master's own event
  await h.advance(300000);
  assert.equal(h.provider.delivered.length, 1);
  assert.match(h.provider.delivered[0].body, /MERGED/);
  assert.doesNotMatch(h.provider.delivered[0].body, /MASTER/);
});

test('API: cancel before processing prevents fan-out', async (t) => {
  const h = await setup(1);
  t.after(() => h.close());
  await h.trigger('early', 'grade-alerts', h.explicit('student_001'), {});
  await h.api('DELETE', '/events/trigger/early');
  await h.tick();
  assert.equal(h.db.get('SELECT COUNT(*) AS n FROM notifications').n, 0);
  assert.equal((await h.api('GET', '/admin/notifications/early')).body.status, 'canceled');
});

test('SECURITY: subscribers only ever see their own data', async (t) => {
  const h = await setup(2);
  t.after(() => h.close());
  await h.trigger('priv-1', 'grade-alerts', h.explicit('student_001'), { course: 'SECRET', grade: '1' });
  await h.trigger('priv-2', 'grade-alerts', h.explicit('student_002'), { course: 'OTHER', grade: '2' });
  await h.tick();
  const alice = await h.asUser('student_001');
  const bob = await h.asUser('student_002');
  const aliceInbox = (await alice('GET', '/inbox/notifications')).body;
  assert.equal(aliceInbox.total, 1);
  assert.match(aliceInbox.notifications[0].content, /SECRET/);
  assert.ok(!JSON.stringify((await bob('GET', '/inbox/notifications')).body).includes('SECRET'));

  // Bob cannot mark Alice's message as seen, and cannot tell it exists.
  const aliceMsg = aliceInbox.notifications[0].messageId;
  assert.equal((await bob('PATCH', `/inbox/notifications/${aliceMsg}/seen`)).status, 404);
  assert.equal((await bob('PATCH', '/inbox/notifications/msg_99999/seen')).status, 404);
  assert.equal((await alice('GET', '/inbox/notifications?seen=false')).body.total, 1);

  // Preferences are scoped to the token's subject; there is no way to name another subscriber.
  await bob('PATCH', '/inbox/preferences', { email: false });
  assert.deepEqual((await alice('GET', '/inbox/preferences')).body.global, { email: true, inApp: true });
});

test('SECURITY: tokens are verified (missing, garbage, tampered, expired, alg=none, wrong org)', async (t) => {
  const h = await setup(1);
  t.after(() => h.close());
  const get = (token) => h.http('GET', '/inbox/notifications', { token });
  assert.equal((await get(undefined)).status, 401);
  assert.equal((await get('garbage')).status, 401);

  const good = await h.login('student_001');
  assert.equal((await get(good)).status, 200);
  const [hd, body, sig] = good.split('.');
  const forgedBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), sub: 'student_002' })).toString('base64url');
  assert.equal((await get(`${hd}.${forgedBody}.${sig}`)).status, 401, 'payload swapped, signature kept');

  const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${body}.`;
  assert.equal((await get(none)).status, 401);

  const { jwtSecret, organizationId } = h.ctx.config;
  const expired = signJwt({ sub: 'student_001', org: organizationId }, jwtSecret, { now: h.clock.now() - 7200000, expiresInS: 60 });
  assert.equal((await get(expired)).status, 401);
  const wrongOrg = signJwt({ sub: 'student_001', org: 'other-campus' }, jwtSecret, { now: h.clock.now() });
  assert.equal((await get(wrongOrg)).status, 401);
  const wrongSecret = signJwt({ sub: 'student_001', org: organizationId }, 'not-the-secret', { now: h.clock.now() });
  assert.equal((await get(wrongSecret)).status, 401);
  const ghost = signJwt({ sub: 'ghost', org: organizationId }, jwtSecret, { now: h.clock.now() });
  assert.equal((await get(ghost)).status, 404, 'validly signed token for a deleted subscriber');
});

test('SECURITY: session minting needs the API key by default; public mode is an explicit opt-in', async (t) => {
  const h = await setup(1);
  t.after(() => h.close());
  const body = { organizationId: h.ctx.config.organizationId, subscriberId: 'student_001' };
  assert.equal((await h.http('POST', '/inbox/session', { body })).status, 401);
  const ok = await h.http('POST', '/inbox/session', { body, key: API_KEY });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.subscriberId, 'student_001');
  assert.equal(ok.body.expiresIn, h.ctx.config.jwtExpiresIn);
  assert.equal((await h.http('POST', '/inbox/session', { body: { ...body, organizationId: 'x' }, key: API_KEY })).status, 404);
  assert.equal((await h.http('POST', '/inbox/session', { body: { ...body, subscriberId: 'ghost' }, key: API_KEY })).status, 404);
  assert.equal((await h.http('POST', '/inbox/session', { body: {}, key: API_KEY })).status, 400);

  const open = await setup(1, { config: { inboxSessionAuth: 'public' } });
  t.after(() => open.close());
  assert.equal((await open.http('POST', '/inbox/session', { body })).status, 200);
});

test('SECURITY: production refuses placeholder secrets; logger redacts secret-looking keys', () => {
  assert.throws(() => assertSafeForProduction(loadConfig({ NODE_ENV: 'production' })), /placeholder/);
  assert.doesNotThrow(() => assertSafeForProduction(loadConfig({ NODE_ENV: 'production', API_KEY: 'k'.repeat(24), JWT_SECRET: 's'.repeat(24) })));
  assert.doesNotThrow(() => assertSafeForProduction(loadConfig({ NODE_ENV: 'development' })));
  const lines = [];
  const orig = console.log;
  console.log = (l) => lines.push(l);
  try {
    require('../src/logger').createLogger('info').info('x', { apiKey: 'abc', webhookSecret: 'def', jobId: 1 });
  } finally {
    console.log = orig;
  }
  assert.ok(!lines[0].includes('abc') && !lines[0].includes('def'));
  assert.ok(lines[0].includes('"jobId":1'));
});

test('ADMIN: activity filters, status, workflow validation', async (t) => {
  const h = await setup(2);
  t.after(() => h.close());
  await h.trigger('adm-1', 'grade-alerts', h.explicit('student_001', 'student_002'), { course: 'A', grade: '1' });
  await h.tick();
  const bySub = await h.api('GET', '/admin/activity?transactionId=adm-1&subscriberId=student_002');
  assert.ok(bySub.body.events.every((e) => !e.subscriberId || e.subscriberId === 'student_002'));
  const sent = await h.api('GET', '/admin/activity?transactionId=adm-1&status=success&limit=2&offset=1');
  assert.equal(sent.body.events.length, 2);
  assert.equal((await h.api('GET', '/admin/activity?status=bogus')).status, 400);
  assert.equal((await h.api('GET', '/admin/activity?limit=-1')).status, 400);
  assert.equal((await h.api('GET', '/admin/activity?transactionId=missing')).status, 404);
  assert.equal((await h.api('GET', '/admin/notifications/missing')).status, 404);
  assert.equal((await h.api('GET', '/admin/notifications/adm-1')).body.recipientStats.total, 2);

  const badDefs = [{}, { steps: [] }, { steps: [{ type: 'sms' }] }, { steps: [{ type: 'email' }, { type: 'digest' }] },
    { steps: [{ type: 'digest', windowMs: -1 }] }, { steps: [{ type: 'email' }], criticalRules: [{ field: 'x', op: 'near', value: 1 }] }];
  for (const def of badDefs) assert.equal((await h.api('PUT', '/admin/workflows/bad', def)).status, 400, JSON.stringify(def));
  assert.equal((await h.api('PUT', '/admin/workflows/__x', { steps: [{ type: 'email' }] })).status, 400);
  assert.equal((await h.api('PUT', '/admin/subscribers/s1', { email: 'nope' })).status, 400);
  assert.equal((await h.http('GET', '/definitely-not-a-route', {})).status, 404);
});

test('UI: the demo console is served at / and has no inline secrets', async (t) => {
  const h = await createHarness();
  t.after(() => h.close());
  const r = await h.http('GET', '/', {});
  assert.equal(r.status, 200);
  assert.match(r.text, /Campus Notification Engine/);
  assert.ok(!r.text.includes(API_KEY));
  assert.ok(!r.text.includes('campus-admin-api-key-change-in-production'));
});
