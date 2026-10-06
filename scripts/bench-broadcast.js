'use strict';

/**
 * Broadcast benchmark: N students (default 30,000), one event, email + in-app.
 * Real engine, real SQLite file (WAL), real worker loop; the email provider is an in-process stub
 * with configurable latency so this measures the engine, not someone's SMTP server.
 *
 *   node scripts/bench-broadcast.js [students=30000] [providerLatencyMs=0] [ratePerSec=0]
 *
 * ratePerSec=0 disables the G6 limiter so the engine's own throughput is visible; with the default
 * limiter (100/s) email time is simply N / rate by design.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');
const { createEngine } = require('../src/engine');

const N = Number(process.argv[2] || 30000);
const LATENCY = Number(process.argv[3] || 0);
const RATE = Number(process.argv[4] || 0);

async function main() {
  const dbPath = path.join(os.tmpdir(), `cne-bench-${Date.now()}.db`);
  const config = loadConfig({}, { dbPath, emailRatePerSec: RATE, emailBreakerThreshold: 0 });
  let sent = 0;
  const provider = {
    name: 'bench-stub',
    async send() {
      if (LATENCY) await new Promise((r) => setTimeout(r, LATENCY));
      sent += 1;
      return { providerMessageId: `b${sent}` };
    },
  };
  const engine = createEngine({ config, emailProvider: provider, logger: createLogger('silent') });
  const { ctx } = engine;

  let t = Date.now();
  ctx.workflows.upsert('bench', {
    steps: [
      { type: 'email', subject: 'Exam {{exam}}', body: '{{exam}} moved to {{room}}' },
      { type: 'in-app', subject: 'Exam {{exam}}', body: '{{exam}} moved to {{room}}' },
    ],
  });
  ctx.db.tx(() => {
    for (let i = 0; i < N; i += 1) ctx.subscribers.upsert(`s${i}`, { email: `s${i}@campus.example` });
  });
  const seedMs = Date.now() - t;

  t = Date.now();
  const res = ctx.ingest.accept({ transactionId: 'bench-1', workflowIdentifier: 'bench', to: { type: 'broadcast' }, payload: { exam: 'CS101', room: 'H123' } });
  const acceptMs = Date.now() - t;

  const start = Date.now();
  // Phase 1: fan-out alone (resolve recipients, create every notification + job chain).
  ctx.ingest.processDueEvents();
  const fanoutMs = Date.now() - start;
  // Phase 2: delivery. In-app pushes are timestamped from the engine's own bus.
  let inApp = 0;
  let inAppFirst = null;
  let inAppHalf = null;
  ctx.bus.on('in-app', () => {
    inApp += 1;
    if (inApp === 1) inAppFirst = Date.now() - start;
    if (inApp === Math.ceil(N / 2)) inAppHalf = Date.now() - start;
  });
  for (;;) {
    await engine.tick();
    if (inApp >= N) break;
    if (RATE) await new Promise((r) => setTimeout(r, 200));
  }
  const totalMs = Date.now() - start;
  const emails = ctx.db.get(`SELECT COUNT(*) AS n FROM messages WHERE channel='email'`).n;
  const dupEmails = ctx.db.get(`SELECT COUNT(*) AS n FROM (SELECT subscriber_id FROM messages WHERE channel='email' GROUP BY subscriber_id HAVING COUNT(*) > 1)`).n;
  await engine.close();
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }

  const out = {
    students: N, providerLatencyMs: LATENCY, ratePerSec: RATE || 'off',
    node: process.version, cpu: os.cpus()[0]?.model, platform: `${os.platform()} ${os.release()}`,
    seedSubscribersMs: seedMs,
    apiAcceptMs: acceptMs, recipientCount: res.recipientCount,
    fanOutCreateAllNotificationsMs: fanoutMs,
    firstStudentNotifiedMs: inAppFirst,
    halfOfStudentsNotifiedMs: inAppHalf,
    allEmailAndInAppDeliveredMs: totalMs,
    perHundredStudentsMs: +(totalMs / (N / 100)).toFixed(1),
    emails, providerCalls: sent, studentsWithDuplicateEmail: dupEmails,
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
