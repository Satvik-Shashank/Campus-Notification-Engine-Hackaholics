'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, seedStandard, addStudents } = require('./helpers');
const { loadConfig, assertSafeForProduction } = require('../src/config');

async function setup(opts) {
  const h = await createHarness(opts);
  await seedStandard(h);
  await addStudents(h, 2);
  return h;
}

test('CONSOLE: stats, events, subscribers, topics, providers and webhook audit endpoints', async (t) => {
  const h = await setup();
  t.after(() => h.close());
  await h.api('PUT', '/admin/topics/CS101/subscribers', { subscriberIds: ['student_001'] });
  await h.trigger('c-1', 'grade-alerts', h.explicit('student_001', 'student_002'), { course: 'A', grade: '1' });
  await h.tick();

  const stats = (await h.api('GET', '/admin/stats')).body;
  assert.equal(stats.events, 1);
  assert.equal(stats.notifications.sent, 2);
  assert.equal(stats.email.sent, 2);
  assert.equal(stats.subscribers, 2);
  assert.equal(stats.hourly.length, 24);
  assert.equal(stats.provider, 'closed');

  const events = (await h.api('GET', '/admin/events?q=c-')).body;
  assert.equal(events.total, 1);
  assert.equal(events.events[0].notifications.sent, 2);

  const subs = (await h.api('GET', '/admin/subscribers?q=001')).body;
  assert.equal(subs.total, 1);
  assert.deepEqual(subs.subscribers[0].topics, ['CS101']);
  assert.deepEqual((await h.api('GET', '/admin/topics')).body.topics, [{ topic: 'CS101', members: 1 }]);

  const prov = (await h.api('GET', '/admin/providers')).body.email;
  assert.equal(prov.counters.sent, 2);
  assert.equal((await h.api('POST', '/admin/providers/email/reset')).status, 200);

  const wh = (await h.api('GET', '/admin/webhooks')).body;
  assert.ok(wh.providers.find((p) => p.provider === 'sendgrid').scheme.startsWith('none'));
  assert.ok(!JSON.stringify(wh).includes('secret-'), 'never exposes secrets');

  for (const path of ['/admin/stats', '/admin/events', '/admin/subscribers', '/admin/topics', '/admin/providers', '/admin/webhooks', '/admin/dead-letters']) {
    assert.equal((await h.http('GET', path, {})).status, 401, `${path} requires the API key`);
  }
  assert.equal((await h.http('GET', '/console/demo', {})).status, 200, 'SPA route served');
  assert.equal((await h.http('GET', '/app/inbox', {})).status, 200, 'SPA route served');
});

test('DEMO: demo routes do not exist unless DEMO_MODE=true, and DEMO_MODE is refused in production', async (t) => {
  const h = await setup();
  t.after(() => h.close());
  assert.equal((await h.api('POST', '/admin/demo/provider-fail', { count: 1 })).status, 404);
  assert.equal((await h.api('GET', '/admin/demo/inspect?transactionIds=x')).status, 404);
  assert.throws(() => assertSafeForProduction(loadConfig({
    NODE_ENV: 'production', DEMO_MODE: 'true', API_KEY: 'k'.repeat(24), JWT_SECRET: 's'.repeat(24),
  })), /DEMO_MODE/);
  assert.equal(loadConfig({ DEMO_MODE: 'true' }).inboxSessionAuth, 'public');
  assert.equal(loadConfig({ DEMO_MODE: 'true', INBOX_SESSION_AUTH: 'api_key' }).inboxSessionAuth, 'api_key');
});

test('DEMO: injected failures drive a real KT3 retry; inspect reports real rows', async (t) => {
  const h = await setup({ config: { demoMode: true } });
  t.after(() => h.close());
  assert.equal((await h.api('POST', '/admin/demo/provider-fail', { count: 1, kind: 'transient' })).body.pendingFaults, 1);
  assert.equal((await h.api('POST', '/admin/demo/provider-fail', { count: 99 })).status, 400);
  await h.trigger('demo-kt3', 'grade-alerts', h.explicit('student_001'), { course: 'A', grade: '1' });
  await h.tick();
  await h.advance(1000);
  const view = (await h.api('GET', '/admin/demo/inspect?transactionIds=demo-kt3')).body;
  const email = view.attempts.filter((a) => a.channel === 'email');
  assert.deepEqual(email.map((a) => [a.attemptNo, a.status]), [[1, 'failed'], [2, 'success']]);
  assert.equal(new Set(email.map((a) => a.idempotencyKey)).size, 1);
  assert.equal(view.messages.filter((m) => m.channel === 'email').length, 1);
  assert.equal(h.provider.delivered.length, 1);

  const timeline = (await h.api('GET', '/admin/demo/timeline?transactionIds=demo-kt3')).body.events.map((e) => e.event);
  assert.ok(timeline.includes('retry_scheduled'));
});

test('DEMO: webhook check fires real requests and only the valid one is applied', async (t) => {
  const h = await setup({ config: { demoMode: true } });
  t.after(() => h.close());
  assert.equal((await h.api('POST', '/admin/demo/webhook-check')).status, 409, 'needs an email first');
  await h.trigger('demo-wh', 'grade-alerts', h.explicit('student_001'), {});
  await h.tick();
  const r = (await h.api('POST', '/admin/demo/webhook-check')).body.results;
  assert.deepEqual(r.map((x) => x.httpStatus), [401, 401, 400, 200]);
  assert.deepEqual(r.slice(0, 3).map((x) => x.providerStatusAfter), [null, null, null], 'rejected webhooks changed nothing');
  assert.equal(r[3].providerStatusAfter, 'delivered');
});
