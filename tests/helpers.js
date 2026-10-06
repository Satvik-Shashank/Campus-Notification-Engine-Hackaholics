'use strict';

const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');
const { createEngine } = require('../src/engine');
const { createApp } = require('../src/http/app');
const { ProviderError } = require('../src/providers/email');

const API_KEY = 'test-key';

class FakeClock {
  constructor(start = Date.UTC(2025, 4, 5, 14, 0, 0)) {
    this.t = start;
  }

  now() {
    return this.t;
  }

  advance(ms) {
    this.t += ms;
  }
}

/**
 * Scripted email provider (the external boundary; everything behind it is the real system).
 * Script entries are consumed one per send call: 'ok' | 'fail-500' | 'fail-permanent' | 'fail-after-send'.
 * dedupByKey mimics providers that honour an idempotency key (replay returns the first result).
 *   calls      every send attempt received
 *   delivered  real deliveries to a recipient (unique per key when dedupByKey, per call otherwise)
 */
class FakeEmailProvider {
  constructor(script = [], { dedupByKey = true } = {}) {
    this.name = 'fake';
    this.script = [...script];
    this.dedupByKey = dedupByKey;
    this.calls = [];
    this.delivered = [];
    this.byKey = new Map();
  }

  record(msg) {
    if (this.dedupByKey && this.byKey.has(msg.idempotencyKey)) return this.byKey.get(msg.idempotencyKey);
    const id = `prov_${this.delivered.length + 1}`;
    this.delivered.push({ id, to: msg.to, subject: msg.subject, body: msg.body, key: msg.idempotencyKey });
    this.byKey.set(msg.idempotencyKey, id);
    return id;
  }

  async send(msg) {
    this.calls.push(msg);
    const step = this.script.shift() || 'ok';
    if (step === 'fail-500') throw new ProviderError('provider returned 500', { transient: true, status: 500 });
    if (step === 'fail-permanent') throw new ProviderError('mailbox does not exist', { transient: false, status: 550 });
    if (step === 'fail-after-send') {
      this.record(msg);
      throw new ProviderError('502 after the provider accepted the message', { transient: true, status: 502 });
    }
    return { providerMessageId: this.record(msg) };
  }
}

async function createHarness({ provider, config = {} } = {}) {
  const clock = new FakeClock();
  const emailProvider = provider || new FakeEmailProvider();
  const cfg = loadConfig({}, {
    dbPath: ':memory:', apiKey: API_KEY, jwtSecret: 'test-secret', rateLimitPerMin: 100000, jwtExpiresIn: 7 * 24 * 3600, ...config,
  });
  const engine = createEngine({ config: cfg, clock, emailProvider, logger: createLogger('silent') });
  const app = createApp(engine);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  async function http(method, path, { body, key, token, headers = {}, rawBody } = {}) {
    const h = { ...headers };
    if (key) h.authorization = `Bearer ${key}`;
    if (token) h.authorization = `Bearer ${token}`;
    let payload;
    if (rawBody !== undefined) payload = rawBody;
    else if (body !== undefined && !['GET', 'HEAD', 'DELETE'].includes(method)) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + path, { method, headers: h, body: payload });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, body: json, text };
  }

  const h = {
    clock,
    engine,
    ctx: engine.ctx,
    db: engine.ctx.db,
    provider: emailProvider,
    http,
    api: (method, path, body, extra = {}) => http(method, path, { body, key: API_KEY, ...extra }),
    /** Move the fake clock forward, then run one worker pass. */
    async advance(ms = 0) {
      clock.advance(ms);
      return engine.tick();
    },
    tick: () => engine.tick(),
    async login(subscriberId) {
      const r = await http('POST', '/inbox/session', { body: { organizationId: cfg.organizationId, subscriberId }, key: API_KEY });
      if (r.status !== 200) throw new Error(`login failed: ${r.status} ${r.text}`);
      return r.body.token;
    },
    async asUser(subscriberId) {
      const token = await h.login(subscriberId);
      return (method, path, body) => http(method, path, { body, token });
    },
    trigger(transactionId, workflowIdentifier, to, payload, extra = {}) {
      return h.api('POST', '/events/trigger', { transactionId, workflowIdentifier, to, payload, ...extra });
    },
    explicit: (...ids) => ({ type: 'explicit', subscriberIds: ids }),
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await engine.close();
    },
  };
  return h;
}

/** Standard workflows used across the suites. */
async function seedStandard(h) {
  const put = async (identifier, def) => {
    const r = await h.api('PUT', `/admin/workflows/${identifier}`, def);
    if (r.status !== 200) throw new Error(`workflow ${identifier}: ${r.status} ${r.text}`);
  };
  await put('exam-digest', {
    correlationKey: 'exam',
    steps: [
      { type: 'digest', windowMs: 300000, digestKey: 'exam' },
      { type: 'email', subject: 'Exam update {{exam}}', body: 'Room for {{exam}}: {{room}}' },
      { type: 'in-app', subject: 'Exam update {{exam}}', body: 'Room for {{exam}}: {{room}}' },
    ],
  });
  await put('exam-live', {
    correlationKey: 'exam',
    criticalRules: [{ field: 'minutesUntilExam', op: 'lt', value: 30 }],
    steps: [
      { type: 'email', subject: 'Exam {{exam}}', body: 'Room for {{exam}}: {{room}}' },
      { type: 'in-app', subject: 'Exam {{exam}}', body: 'Room for {{exam}}: {{room}}' },
    ],
  });
  await put('grade-alerts', {
    correlationKey: 'course',
    steps: [
      { type: 'email', subject: 'Grade {{course}}', body: '{{course}}: {{grade}}' },
      { type: 'in-app', subject: 'Grade {{course}}', body: '{{course}}: {{grade}}' },
    ],
  });
  await put('emergency-alert', {
    critical: true,
    steps: [
      { type: 'email', subject: '{{title}}', body: '{{title}}' },
      { type: 'in-app', subject: '{{title}}', body: '{{title}}' },
    ],
  });
}

async function addStudents(h, count) {
  const ids = [];
  for (let i = 1; i <= count; i += 1) {
    const id = `student_${String(i).padStart(3, '0')}`;
    const r = await h.api('PUT', `/admin/subscribers/${id}`, { email: `${id}@campus.example` });
    if (r.status !== 200) throw new Error(`subscriber ${id}: ${r.status} ${r.text}`);
    ids.push(id);
  }
  return ids;
}

const activityEvents = (h, transactionId) => h.api('GET', `/admin/activity?transactionId=${encodeURIComponent(transactionId)}&limit=500`)
  .then((r) => r.body.events.map((e) => e.event));

module.exports = { API_KEY, FakeClock, FakeEmailProvider, createHarness, seedStandard, addStudents, activityEvents };
