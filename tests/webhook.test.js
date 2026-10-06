'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createHarness, seedStandard, addStudents } = require('./helpers');

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const SECRET = 'whsec-test-generic';
const MG_SECRET = 'whsec-test-mailgun';

async function setup(config = {}) {
  const h = await createHarness({
    config: {
      webhookSecrets: { generic: SECRET, mailgun: MG_SECRET, sendgrid: 'a-secret-that-cannot-be-used' },
      webhookAllowUnverified: {},
      ...config,
    },
  });
  await seedStandard(h);
  await addStudents(h, 1);
  await h.trigger('wh-1', 'grade-alerts', h.explicit('student_001'), { course: 'CS101', grade: '1' });
  await h.tick();
  const msg = h.db.get(`SELECT * FROM messages WHERE channel='email'`);
  assert.ok(msg.provider_message_id, 'precondition: a delivered email with a provider message id');
  return { h, msg };
}

const post = (h, provider, body, headers = {}) => h.http('POST', `/webhooks/${provider}`, {
  rawBody: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers },
});
const sign = (raw) => ({ 'x-webhook-signature': `sha256=${hmac(SECRET, raw)}` });
const providerStatus = (h, id) => h.db.get('SELECT provider_status, status FROM messages WHERE id = ?', id);
const lastWebhook = (h) => h.db.get('SELECT * FROM webhook_events ORDER BY id DESC LIMIT 1');

test('FIX: a valid signature is accepted and processed', async (t) => {
  const { h, msg } = await setup();
  t.after(() => h.close());
  const raw = JSON.stringify({ events: [{ event: 'delivered', messageId: msg.provider_message_id }] });
  const r = await post(h, 'generic', raw, sign(raw));
  assert.equal(r.status, 200);
  assert.equal(r.body.verified, true);
  assert.equal(r.body.applied, 1);
  assert.equal(providerStatus(h, msg.id).provider_status, 'delivered');
  assert.equal(lastWebhook(h).verification, 'valid');
});

test('FIX: an invalid signature is rejected (401) and changes nothing', async (t) => {
  const { h, msg } = await setup();
  t.after(() => h.close());
  const raw = JSON.stringify({ event: 'bounce', messageId: msg.provider_message_id });
  const bad = await post(h, 'generic', raw, { 'x-webhook-signature': `sha256=${hmac('wrong-secret', raw)}` });
  assert.equal(bad.status, 401);
  assert.equal(providerStatus(h, msg.id).provider_status, null);
  assert.equal(lastWebhook(h).outcome, 'rejected');

  // Signature valid for different bytes (tampered body) is also invalid.
  const tampered = await post(h, 'generic', raw.replace('bounce', 'delivered'), sign(raw));
  assert.equal(tampered.status, 401);

  // Malformed signature header.
  assert.equal((await post(h, 'generic', raw, { 'x-webhook-signature': 'not-a-signature' })).status, 401);
  assert.equal(providerStatus(h, msg.id).provider_status, null);
  assert.equal(h.db.get('SELECT SUM(applied) AS n FROM webhook_events').n, 0);
});

test('FIX: a missing signature is rejected (401)', async (t) => {
  const { h, msg } = await setup();
  t.after(() => h.close());
  const r = await post(h, 'generic', { event: 'bounce', messageId: msg.provider_message_id });
  assert.equal(r.status, 401);
  assert.equal(r.body.verification, 'missing');
  assert.equal(providerStatus(h, msg.id).provider_status, null);
});

test('FIX: unsupported verification fails closed (never silently trusted)', async (t) => {
  const { h, msg } = await setup();
  t.after(() => h.close());
  const body = { event: 'delivered', messageId: msg.provider_message_id };

  // sendgrid: known provider, no verifier implemented. A configured secret must not change that.
  const sg = await post(h, 'sendgrid', body, { 'x-webhook-signature': `sha256=${hmac('a-secret-that-cannot-be-used', JSON.stringify(body))}` });
  assert.equal(sg.status, 400);
  assert.equal(sg.body.verification, 'unsupported');

  // Unknown provider name: same.
  assert.equal((await post(h, 'madeupmail', body)).status, 400);

  // Invalid provider name is rejected outright.
  assert.equal((await post(h, 'bad%20name', body)).status, 400);

  assert.equal(providerStatus(h, msg.id).provider_status, null, 'nothing was applied');
  assert.equal(h.db.get('SELECT SUM(applied) AS n FROM webhook_events').n, 0);
});

test('FIX: a verifiable provider with no configured secret is rejected, not trusted', async (t) => {
  const { h, msg } = await setup({ webhookSecrets: {} });
  t.after(() => h.close());
  const raw = JSON.stringify({ event: 'delivered', messageId: msg.provider_message_id });
  const r = await post(h, 'generic', raw, sign(raw));
  assert.equal(r.status, 400);
  assert.equal(r.body.verification, 'unconfigured');
  assert.equal(providerStatus(h, msg.id).provider_status, null);
});

test('FIX: explicit opt-in records an unsupported provider webhook as unverified and still never applies it', async (t) => {
  const { h, msg } = await setup({ webhookAllowUnverified: { sendgrid: true } });
  t.after(() => h.close());
  const r = await post(h, 'sendgrid', { event: 'delivered', messageId: msg.provider_message_id });
  assert.equal(r.status, 202);
  assert.equal(r.body.verified, false);
  assert.equal(r.body.applied, 0);
  assert.equal(providerStatus(h, msg.id).provider_status, null);
  const row = lastWebhook(h);
  assert.equal(row.verification, 'unverified');
  assert.equal(row.applied, 0);
  // Opt-in does not rescue a verifiable provider whose signature is wrong.
  assert.equal((await post(h, 'generic', { event: 'delivered' }, { 'x-webhook-signature': 'sha256=' + 'a'.repeat(64) })).status, 401);
});

test('FIX: timestamp-token scheme: valid, stale and forged', async (t) => {
  const { h, msg } = await setup();
  t.after(() => h.close());
  const nowS = Math.floor(h.clock.now() / 1000);
  const mk = (timestamp, token, secret) => ({
    signature: { timestamp: String(timestamp), token, signature: hmac(secret, `${timestamp}${token}`) },
    'event-data': { event: 'delivered', message: { headers: { 'message-id': msg.provider_message_id } } },
  });

  const ok = await post(h, 'mailgun', mk(nowS, 'tok1', MG_SECRET));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.applied, 1);
  assert.equal(providerStatus(h, msg.id).provider_status, 'delivered');

  h.db.run('UPDATE messages SET provider_status = NULL WHERE id = ?', msg.id);
  assert.equal((await post(h, 'mailgun', mk(nowS - 3600, 'tok2', MG_SECRET))).status, 401, 'stale timestamp');
  assert.equal((await post(h, 'mailgun', mk(nowS, 'tok3', 'wrong'))).status, 401, 'forged signature');
  assert.equal((await post(h, 'mailgun', { 'event-data': { event: 'delivered' } })).status, 401, 'no signature block');
  assert.equal(providerStatus(h, msg.id).provider_status, null);
});

test('FIX: verified bounce marks the message delivery_failed; unknown message ids are ignored; bad JSON applies nothing', async (t) => {
  const { h, msg } = await setup();
  t.after(() => h.close());
  const raw = JSON.stringify({ events: [{ event: 'bounce', messageId: msg.provider_message_id }, { event: 'delivered', messageId: 'nope' }] });
  const r = await post(h, 'generic', raw, sign(raw));
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.applied, r.body.ignored], [1, 1]);
  assert.deepEqual({ ...providerStatus(h, msg.id) }, { provider_status: 'bounced', status: 'delivery_failed' });

  const junk = '{not json';
  const j = await post(h, 'generic', junk, sign(junk));
  assert.equal(j.status, 200);
  assert.equal(j.body.applied, 0);
});

test('FIX: webhook audit rows never contain the signature or secret', async (t) => {
  const { h } = await setup();
  t.after(() => h.close());
  const raw = JSON.stringify({ event: 'delivered', messageId: 'x' });
  await post(h, 'generic', raw, sign(raw));
  const dump = JSON.stringify(h.db.all('SELECT * FROM webhook_events'));
  assert.ok(!dump.includes(SECRET));
  assert.ok(!dump.includes(hmac(SECRET, raw)));
});
