'use strict';

/**
 * Crash / recovery proof with real processes:
 *   1. start the server on a SQLite file, broadcast one event to N students,
 *   2. hard-kill the process (SIGKILL / TerminateProcess) while delivery is in progress,
 *   3. restart it on the same file and let it finish,
 *   4. check from the database: every student has exactly one email and one in-app message
 *      (nobody lost, no duplicate records), and count provider sends per idempotency key across
 *      both processes from the console provider's log.
 * Jobs left 'running' by the crash are reclaimed after JOB_LOCK_TIMEOUT_MS (set to 2 s here).
 *
 *   node scripts/crash-test.js [students=3000]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const N = Number(process.argv[2] || 3000);
const PORT = 3970 + Math.floor(Math.random() * 9);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = 'crash-test-api-key-1234567890';
const root = path.join(__dirname, '..');
const dbPath = path.join(os.tmpdir(), `cne-crash-${Date.now()}.db`);
const env = {
  ...process.env, PORT: String(PORT), DB_PATH: dbPath, API_KEY: KEY, LOG_LEVEL: 'info',
  WORKER_TICK_MS: '100', JOB_LOCK_TIMEOUT_MS: '2000', EMAIL_RATE_PER_SEC: '0', DEMO_MODE: 'false',
};
const sends = [];

function start(label) {
  const child = spawn(process.execPath, ['src/index.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) {
      if (!l.includes('email (console provider)')) continue;
      try { sends.push({ proc: label, key: JSON.parse(l).idempotencyKey }); } catch { /* partial line */ }
    }
  });
  return child;
}
const ready = async () => {
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
};
const api = (method, p, body) => fetch(BASE + p, {
  method, headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body),
}).then((r) => r.json());
const count = (sql) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try { return db.prepare(sql).get().n; } finally { db.close(); }
};

async function main() {
  let proc = start('first');
  await ready();
  await api('PUT', '/admin/workflows/crash', { steps: [{ type: 'email', subject: 'Exam {{exam}}', body: 'room {{room}}' }, { type: 'in-app', subject: 'Exam {{exam}}', body: 'room {{room}}' }] });
  const ids = Array.from({ length: N }, (_, i) => `c${i}`);
  for (let i = 0; i < N; i += 200) {
    await Promise.all(ids.slice(i, i + 200).map((id) => api('PUT', `/admin/subscribers/${id}`, { email: `${id}@campus.example` })));
  }
  const accepted = await api('POST', '/events/trigger/broadcast', { transactionId: 'crash-1', workflowIdentifier: 'crash', payload: { exam: 'CS101', room: 'H123' } });

  // Wait until delivery is clearly in progress, then kill without any shutdown hook.
  for (;;) {
    await new Promise((r) => setTimeout(r, 50));
    const done = count(`SELECT COUNT(*) AS n FROM messages WHERE channel = 'email'`);
    if (done >= N * 0.3) break;
  }
  proc.kill('SIGKILL');
  await new Promise((r) => proc.once('exit', r));
  const atCrash = {
    emails: count(`SELECT COUNT(*) AS n FROM messages WHERE channel = 'email'`),
    inApp: count(`SELECT COUNT(*) AS n FROM messages WHERE channel = 'in-app'`),
    running: count(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'`),
  };

  proc = start('second');
  await ready();
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 250));
    if (count(`SELECT COUNT(*) AS n FROM messages WHERE channel = 'in-app'`) >= N) break;
    if (Date.now() - t0 > 120000) break;
  }
  await new Promise((r) => setTimeout(r, 500));
  proc.kill('SIGKILL');
  await new Promise((r) => proc.once('exit', r));

  const perKey = new Map();
  for (const s of sends) perKey.set(s.key, (perKey.get(s.key) || 0) + 1);
  const result = {
    students: N, recipientCount: accepted.recipientCount, killedAt: atCrash,
    recoveryMs: Date.now() - t0,
    notifications: count('SELECT COUNT(*) AS n FROM notifications'),
    studentsWithEmail: count(`SELECT COUNT(DISTINCT subscriber_id) AS n FROM messages WHERE channel = 'email'`),
    studentsWithInApp: count(`SELECT COUNT(DISTINCT subscriber_id) AS n FROM messages WHERE channel = 'in-app'`),
    duplicateEmailRecords: count(`SELECT COUNT(*) AS n FROM (SELECT subscriber_id FROM messages WHERE channel='email' GROUP BY subscriber_id HAVING COUNT(*) > 1)`),
    duplicateInAppRecords: count(`SELECT COUNT(*) AS n FROM (SELECT subscriber_id FROM messages WHERE channel='in-app' GROUP BY subscriber_id HAVING COUNT(*) > 1)`),
    failedJobs: count(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'failed'`),
    providerSendsLogged: sends.length,
    keysSentMoreThanOnce: [...perKey.values()].filter((v) => v > 1).length,
  };
  console.log(JSON.stringify(result, null, 2));
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
  const ok = result.studentsWithEmail === N && result.studentsWithInApp === N && result.duplicateEmailRecords === 0
    && result.duplicateInAppRecords === 0 && result.notifications === N;
  console.log(ok ? 'PASS: nobody lost, no duplicate records' : 'FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
