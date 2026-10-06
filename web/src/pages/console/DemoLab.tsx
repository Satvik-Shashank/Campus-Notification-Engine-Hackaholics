import { useRef, useState } from 'react';
import { admin, asStudent, mintToken, type ActivityEvent, type FocusSummary } from '../../api';
import { Badge, Button, Card, Mono, PageTitle, cx } from '../../components/ui';
import { Timeline } from './Console';

// Every scenario drives the real public API, then reads real rows back (/admin/demo/inspect) to decide
// pass/fail. Nothing is simulated in the browser.

interface Inspect {
  notifications: { transactionId: string; subscriberId: string; status: string; email: string; inApp: string }[];
  messages: { channel: string; transactionId: string; subject: string; content: string; idempotencyKey: string; providerMessageId: string | null }[];
  attempts: { transactionId: string; channel: string; attemptNo: number; status: string; error: string | null; idempotencyKey: string }[];
  deadLetters: { id: number; channel: string; reason: string; status: string }[];
}
interface Check { label: string; ok: boolean; detail?: string }
type Log = (line: string) => void;
interface Result { checks: Check[]; txns: string[]; extra?: React.ReactNode }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs: number, every = 500): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}
const inspect = (txns: string[]) => admin.get<Inspect>(`/admin/demo/inspect?transactionIds=${encodeURIComponent(txns.join(','))}`);
const runId = () => Date.now().toString(36);
const student = async (id: string) => { await admin.put(`/admin/subscribers/${id}`, { email: `${id}@campus.example` }); return id; };
const workflow = (id: string, def: unknown) => admin.put(`/admin/workflows/${id}`, def);
const trigger = (transactionId: string, workflowIdentifier: string, ids: string[], payload: unknown, priority = 'normal') =>
  admin.post('/events/trigger', { transactionId, workflowIdentifier, to: { type: 'explicit', subscriberIds: ids }, payload, priority });
const chan = (i: Inspect, c: string) => i.messages.filter((m) => m.channel === c);
const twoSteps = (subject: string, body: string) => [{ type: 'email', subject, body }, { type: 'in-app', subject, body }];

interface Scenario {
  id: string; tag: string; title: string; claim: string; seconds: string;
  run: (log: Log, opts: { windowSec: number }) => Promise<Result>;
}

const SCENARIOS: Scenario[] = [
  {
    id: 'kt1', tag: 'Killer Test 1', title: 'Ten events within the window become one digest', seconds: '≈ window + 5 s',
    claim: 'Ten room changes for the same exam, to the same student, inside the digest window produce exactly one email and one in-app message that contain all ten.',
    async run(log, { windowSec }) {
      const r = runId();
      const sid = await student(`kt1_${r}`);
      await workflow('demo-kt1', { steps: [{ type: 'digest', windowMs: windowSec * 1000, digestKey: 'exam' }, ...twoSteps('Exam update {{exam}}', '{{exam}} moved to room {{room}}')] });
      log(`Workflow demo-kt1: digest ${windowSec}s → email → in-app. Student ${sid}.`);
      const txns: string[] = [];
      for (let i = 1; i <= 10; i += 1) {
        const t = `kt1-${r}-${i}`;
        await trigger(t, 'demo-kt1', [sid], { exam: 'CS101', room: `H${100 + i}` });
        txns.push(t);
        log(`Sent event ${i}/10 (room H${100 + i}) → 202`);
        await sleep(250);
      }
      await sleep(1200);
      const during = await inspect(txns);
      log(`While the window is open: ${during.messages.length} message(s) delivered.`);
      log(`Waiting for the ${windowSec}s window to close…`);
      const after = await waitFor(async () => { const x = await inspect(txns); return chan(x, 'email').length && chan(x, 'in-app').length ? x : null; }, windowSec * 1000 + 15000);
      const fin = after ?? (await inspect(txns));
      const email = chan(fin, 'email');
      const by = (s: string) => fin.notifications.filter((n) => n.status === s).length;
      const rooms = Array.from({ length: 10 }, (_, i) => `H${101 + i}`);
      return {
        txns,
        checks: [
          { label: 'Nothing delivered while the window was open', ok: during.messages.length === 0, detail: `${during.messages.length} message(s)` },
          { label: 'Exactly one email', ok: email.length === 1, detail: `${email.length}` },
          { label: 'Exactly one in-app message', ok: chan(fin, 'in-app').length === 1, detail: `${chan(fin, 'in-app').length}` },
          { label: 'The digest contains all ten events', ok: !!email[0] && rooms.every((x) => new RegExp(`\\b${x}\\b`).test(email[0].content)), detail: email[0]?.subject },
          { label: '10 notifications: 1 sent + 9 merged into the digest', ok: fin.notifications.length === 10 && by('sent') === 1 && by('digested') === 9, detail: `sent ${by('sent')}, digested ${by('digested')}` },
        ],
        extra: email[0] && <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-sunken p-3 text-xs">{email[0].subject}{'\n'}{email[0].content}</pre>,
      };
    },
  },
  {
    id: 'kt2', tag: 'Killer Test 2', title: 'Email muted → in-app only', seconds: '≈ 3 s',
    claim: 'A student who muted email gets the notification in-app; the email step is skipped (no attempt), not failed or retried.',
    async run(log) {
      const r = runId();
      const sid = await student(`kt2_${r}`);
      await workflow('demo-kt2', { steps: twoSteps('Grade posted {{course}}', '{{course}}: {{grade}}') });
      const tok = await mintToken(sid);
      await asStudent(tok, 'PATCH', '/inbox/preferences', { email: false, inApp: true });
      log(`${sid} muted email via PATCH /inbox/preferences (as the student).`);
      const t = `kt2-${r}`;
      await trigger(t, 'demo-kt2', [sid], { course: 'CS101', grade: '89' });
      log('Event sent → 202. Waiting for delivery…');
      const fin = await waitFor(async () => { const x = await inspect([t]); return x.notifications[0] && !['pending', 'processing'].includes(x.notifications[0].status) ? x : null; }, 15000) ?? await inspect([t]);
      const inbox = await asStudent<{ total: number }>(tok, 'GET', '/inbox/notifications');
      const n = fin.notifications[0];
      return {
        txns: [t],
        checks: [
          { label: 'Email step skipped', ok: n?.email === 'skipped', detail: n?.email },
          { label: 'Zero email attempts reached the provider', ok: fin.attempts.filter((a) => a.channel === 'email').length === 0 },
          { label: 'In-app delivered', ok: n?.inApp === 'sent', detail: n?.inApp },
          { label: "It is in the student's inbox", ok: inbox.total === 1, detail: `${inbox.total} item(s)` },
          { label: 'No email message exists', ok: chan(fin, 'email').length === 0 },
        ],
      };
    },
  },
  {
    id: 'kt3', tag: 'Killer Test 3', title: 'Failed send is retried without duplicates', seconds: '≈ 4 s',
    claim: 'The provider fails the first send (500). The system retries after backoff with the same idempotency key and delivers exactly once.',
    async run(log) {
      const r = runId();
      const sid = await student(`kt3_${r}`);
      await workflow('demo-kt3', { steps: twoSteps('Exam reminder {{exam}}', '{{exam}} is in room {{room}}') });
      await admin.post('/admin/demo/provider-fail', { count: 1, kind: 'transient' });
      log('Armed the email provider to fail its next send with a 500.');
      const t = `kt3-${r}`;
      await trigger(t, 'demo-kt3', [sid], { exam: 'CS101', room: 'H123' });
      log('Event sent → 202. Watching attempts…');
      const fin = await waitFor(async () => { const x = await inspect([t]); return chan(x, 'email').length ? x : null; }, 20000) ?? await inspect([t]);
      const att = fin.attempts.filter((a) => a.channel === 'email');
      return {
        txns: [t],
        checks: [
          { label: 'Attempt 1 failed (provider 500)', ok: att[0]?.status === 'failed', detail: att[0]?.error ?? undefined },
          { label: 'Attempt 2 succeeded', ok: att[1]?.status === 'success' },
          { label: 'Both attempts used the same idempotency key', ok: att.length >= 2 && new Set(att.map((a) => a.idempotencyKey)).size === 1, detail: att[0]?.idempotencyKey },
          { label: 'Exactly one email message', ok: chan(fin, 'email').length === 1 },
          { label: 'Still one logical notification', ok: fin.notifications.length === 1 },
        ],
      };
    },
  },
  {
    id: 'fix', tag: 'Fix', title: 'Webhooks fail closed', seconds: '≈ 1 s',
    claim: 'Four real requests hit POST /webhooks: forged, unsigned and unverifiable ones are rejected and change nothing; only the correctly signed one is applied.',
    async run(log) {
      const r = runId();
      const sid = await student(`fix_${r}`);
      await workflow('demo-kt3', { steps: twoSteps('Exam reminder {{exam}}', '{{exam}} is in room {{room}}') });
      const t = `fix-${r}`;
      await trigger(t, 'demo-kt3', [sid], { exam: 'CS101', room: 'H123' });
      await waitFor(async () => chan(await inspect([t]), 'email').length > 0, 15000);
      log('Delivered an email to have a real provider message id.');
      const res = await admin.post<{ messageId: string; results: { case: string; httpStatus: number; providerStatusBefore: string | null; providerStatusAfter: string | null; claimedEvent: string }[] }>('/admin/demo/webhook-check');
      res.results.forEach((x) => log(`${x.case}: HTTP ${x.httpStatus}, provider status ${x.providerStatusBefore ?? 'none'} → ${x.providerStatusAfter ?? 'none'}`));
      const [forged, missing, unsupported, valid] = res.results;
      return {
        txns: [t],
        checks: [
          { label: 'Forged signature → 401, nothing applied', ok: forged.httpStatus === 401 && forged.providerStatusAfter === null },
          { label: 'Missing signature → 401, nothing applied', ok: missing.httpStatus === 401 && missing.providerStatusAfter === null },
          { label: 'Provider without a verifier → 400, nothing applied', ok: unsupported.httpStatus === 400 && unsupported.providerStatusAfter === null },
          { label: 'Valid signature → 200 and applied', ok: valid.httpStatus === 200 && valid.providerStatusAfter === 'delivered' },
        ],
      };
    },
  },
  {
    id: 'focus', tag: 'Differentiator', title: 'Intelligent Focus Mode', seconds: '≈ 8 s',
    claim: 'During focus, normal updates are held, a critical one arrives at once, and ending focus produces one catch-up that reports what changed and drops what the student already knows.',
    async run(log) {
      const r = runId();
      const sid = await student(`focus_${r}`);
      await workflow('demo-focus-exam', { correlationKey: 'exam', criticalRules: [{ field: 'minutesUntilExam', op: 'lt', value: 30 }], steps: twoSteps('Exam {{exam}}', '{{exam}}: room {{room}}') });
      await workflow('demo-focus-grade', { correlationKey: 'course', steps: twoSteps('Grade {{course}}', '{{course}}: {{grade}}') });
      const tok = await mintToken(sid);
      await asStudent(tok, 'POST', '/inbox/focus-mode/start', { duration: '2h' });
      log(`${sid} started a 2-hour focus session.`);
      const txns = [`fo-${r}-1`, `fo-${r}-2`, `fo-${r}-3`, `fo-${r}-4`, `fo-${r}-5`];
      await trigger(txns[0], 'demo-focus-exam', [sid], { exam: 'DBMS', room: 'A201' });
      await trigger(txns[1], 'demo-focus-exam', [sid], { exam: 'DBMS', room: 'H123' });
      await trigger(txns[2], 'demo-focus-exam', [sid], { exam: 'DBMS', room: 'H123', confirmed: true });
      await trigger(txns[3], 'demo-focus-grade', [sid], { course: 'Discrete Math', grade: '89' });
      log('Sent: room → A201, room → H123, "H123 confirmed", grade posted.');
      const held = await waitFor(async () => { const s = await asStudent<{ heldCount: number }>(tok, 'GET', '/inbox/focus-mode/status'); return s.heldCount >= 4 ? s : null; }, 15000);
      const inboxDuring = await asStudent<{ total: number }>(tok, 'GET', '/inbox/notifications');
      log(`Held: ${held?.heldCount ?? 0}. Inbox during focus: ${inboxDuring.total}.`);
      await trigger(txns[4], 'demo-focus-exam', [sid], { exam: 'DBMS', room: 'H123', minutesUntilExam: 15 });
      log('Sent critical: "DBMS starts in 15 minutes, room H123".');
      const crit = await waitFor(async () => { const x = await asStudent<{ total: number }>(tok, 'GET', '/inbox/notifications'); return x.total >= 1 ? x : null; }, 15000);
      await asStudent(tok, 'POST', '/inbox/focus-mode/end');
      log('Focus ended → catch-up summary generated.');
      const inboxAfter = await waitFor(async () => { const x = await asStudent<{ total: number }>(tok, 'GET', '/inbox/notifications'); return x.total >= 2 ? x : null; }, 15000);
      const s = await asStudent<FocusSummary>(tok, 'GET', '/inbox/focus-mode/summary');
      const exam = s.items.find((i) => i.label === 'exam DBMS');
      const grade = s.items.find((i) => i.label === 'course Discrete Math');
      return {
        txns,
        checks: [
          { label: 'Four normal updates held, none delivered during focus', ok: (held?.heldCount ?? 0) === 4 && inboxDuring.total === 0 },
          { label: 'The critical alert bypassed focus immediately', ok: !!crit && crit.total === 1 },
          { label: 'One catch-up summary delivered when focus ended', ok: s.sent && !!inboxAfter && inboxAfter.total === 2 },
          { label: 'Related exam events correlated into one item showing the change', ok: !!exam && exam.changes.some((c) => c.field === 'room' && c.from === 'A201' && c.to === 'H123') },
          { label: 'New information kept (room confirmed), grade listed', ok: !!exam && exam.latest.confirmed === true && !!grade },
          { label: 'Already-known fact suppressed ("room H123" was in the critical alert)', ok: s.suppressed.acknowledged >= 1, detail: `${s.suppressed.acknowledged} suppressed` },
        ],
        extra: <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-sunken p-3 text-xs">{s.subject}{'\n'}{s.text}</pre>,
      };
    },
  },
  {
    id: 'g7', tag: 'Gap G7', title: 'Dead-letter queue: fail → park → retry once', seconds: '≈ 4 s',
    claim: 'A permanent provider error parks the delivery in the dead-letter queue. An operator retry delivers it exactly once with the same idempotency key.',
    async run(log) {
      const r = runId();
      const sid = await student(`g7_${r}`);
      await workflow('demo-kt3', { steps: twoSteps('Exam reminder {{exam}}', '{{exam}} is in room {{room}}') });
      await admin.post('/admin/demo/provider-fail', { count: 1, kind: 'permanent' });
      const t = `g7-${r}`;
      await trigger(t, 'demo-kt3', [sid], { exam: 'CS101', room: 'H123' });
      log('Armed a permanent (550) failure and sent the event.');
      const parked = await waitFor(async () => { const x = await inspect([t]); return x.deadLetters.find((d) => d.status === 'open') ?? null; }, 15000);
      log(parked ? `Dead letter #${parked.id} (${parked.reason}). Retrying it…` : 'No dead letter appeared.');
      if (parked) await admin.post(`/admin/dead-letters/${parked.id}/retry`);
      const fin = await waitFor(async () => { const x = await inspect([t]); return chan(x, 'email').length ? x : null; }, 15000) ?? await inspect([t]);
      const att = fin.attempts.filter((a) => a.channel === 'email');
      return {
        txns: [t],
        checks: [
          { label: 'Permanent failure landed in the dead-letter queue', ok: parked?.reason === 'permanent_error' },
          { label: 'Retry delivered exactly one email', ok: chan(fin, 'email').length === 1 },
          { label: 'Attempt history kept: failed, then success, same key', ok: att.map((a) => a.status).join(',') === 'failed,success' && new Set(att.map((a) => a.idempotencyKey)).size === 1 },
          { label: 'Letter marked retried', ok: fin.deadLetters.every((d) => d.status === 'retried') },
        ],
      };
    },
  },
  {
    id: 'g8', tag: 'Gap G8', title: 'One digest across three workflows', seconds: '≈ 13 s',
    claim: 'Room, time and invigilator changes come from three different workflows but share a digest group, so the student gets one email about the exam.',
    async run(log) {
      const r = runId();
      const sid = await student(`g8_${r}`);
      const step = { type: 'digest', windowMs: 8000, digestKey: 'exam', groupScope: 'demo-exam' };
      await workflow('demo-g8-room', { steps: [step, ...twoSteps('Exam {{exam}}', 'Room moved to {{room}}')] });
      await workflow('demo-g8-time', { steps: [step, ...twoSteps('Exam {{exam}}', 'Now starts at {{time}}')] });
      await workflow('demo-g8-staff', { steps: [step, ...twoSteps('Exam {{exam}}', 'Invigilator is {{who}}')] });
      const txns = [`g8-${r}-1`, `g8-${r}-2`, `g8-${r}-3`];
      await trigger(txns[0], 'demo-g8-room', [sid], { exam: 'CS101', room: 'H123' });
      await trigger(txns[1], 'demo-g8-time', [sid], { exam: 'CS101', time: '2:00 PM' });
      await trigger(txns[2], 'demo-g8-staff', [sid], { exam: 'CS101', who: 'Dr. Rao' });
      log('Three events from three workflows (group "demo-exam", 8 s window). Waiting…');
      await waitFor(async () => { const x = await inspect(txns); return chan(x, 'email').length ? x : null; }, 25000);
      await sleep(800);
      const final = await inspect(txns);
      const email = chan(final, 'email');
      return {
        txns,
        checks: [
          { label: 'Exactly one email for three workflows', ok: email.length === 1 },
          { label: 'It names all three sources', ok: !!email[0] && ['demo-g8-room', 'demo-g8-time', 'demo-g8-staff'].every((w) => email[0].content.includes(`[${w}]`)) },
          { label: 'One in-app message', ok: chan(final, 'in-app').length === 1 },
          { label: 'Two notifications merged into the first', ok: final.notifications.filter((n) => n.status === 'digested').length === 2 },
        ],
        extra: email[0] && <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-sunken p-3 text-xs">{email[0].content}</pre>,
      };
    },
  },
  {
    id: 'g6', tag: 'Gap G6', title: 'Provider outage: circuit opens, nobody is lost', seconds: '≈ 35 s',
    claim: 'Five straight provider failures open the circuit. Held deliveries keep their retry budget, and after recovery every student gets exactly one email.',
    async run(log) {
      const r = runId();
      const ids = await Promise.all(Array.from({ length: 6 }, (_, i) => student(`g6_${r}_${i + 1}`)));
      await workflow('demo-g6', { steps: [{ type: 'email', subject: 'Exam {{exam}}', body: '{{exam}} room {{room}}' }] });
      await admin.post('/admin/providers/email/reset');
      await admin.post('/admin/demo/provider-fail', { count: 5, kind: 'transient' });
      const t = `g6-${r}`;
      await trigger(t, 'demo-g6', ids, { exam: 'CS101', room: 'H123' });
      log('Provider will fail the next 5 sends. One event to 6 students.');
      const opened = await waitFor(async () => {
        const p = await admin.get<{ email: { breaker: { state: string } } }>('/admin/providers');
        return p.email.breaker.state === 'open' ? p : null;
      }, 15000);
      log(opened ? 'Circuit OPEN: remaining sends are held, not attempted.' : 'Circuit did not open.');
      const mid = await inspect([t]);
      log('Waiting for the 30 s cooldown; the probe then succeeds and the queue drains…');
      const fin = await waitFor(async () => { const x = await inspect([t]); return chan(x, 'email').length >= 6 ? x : null; }, 60000, 1000) ?? await inspect([t]);
      const maxAttempts = Math.max(0, ...fin.attempts.map((a) => a.attemptNo));
      return {
        txns: [t],
        checks: [
          { label: 'Circuit opened after consecutive failures', ok: !!opened },
          { label: 'While open, held students had no attempt spent', ok: mid.attempts.length <= 5, detail: `${mid.attempts.length} attempts recorded` },
          { label: 'Every student got exactly one email', ok: chan(fin, 'email').length === 6 && new Set(chan(fin, 'email').map((m) => m.idempotencyKey)).size === 6 },
          { label: 'No one exhausted their retry budget', ok: maxAttempts <= 3 && fin.deadLetters.length === 0, detail: `max attempt #${maxAttempts}` },
        ],
      };
    },
  },
];

function ScenarioCard({ s, windowSec }: { s: Scenario; windowSec: number }) {
  const [state, setState] = useState<'idle' | 'running' | 'pass' | 'fail' | 'error'>('idle');
  const [lines, setLines] = useState<string[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [timeline, setTimeline] = useState<ActivityEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(0);
  const run = async () => {
    setState('running'); setLines([]); setResult(null); setTimeline([]); setError(null);
    started.current = Date.now();
    const log: Log = (l) => setLines((x) => [...x, `${((Date.now() - started.current) / 1000).toFixed(1)}s  ${l}`]);
    try {
      const res = await s.run(log, { windowSec });
      setResult(res);
      const tl = await admin.get<{ events: ActivityEvent[] }>(`/admin/demo/timeline?transactionIds=${encodeURIComponent(res.txns.join(','))}`);
      setTimeline(tl.events);
      setState(res.checks.every((c) => c.ok) ? 'pass' : 'fail');
      log(`Done in ${((Date.now() - started.current) / 1000).toFixed(1)}s.`);
    } catch (e) {
      setError((e as Error).message);
      setState('error');
    }
  };
  return (
    <Card className={cx(state === 'pass' && 'ring-2 ring-ok/40', (state === 'fail' || state === 'error') && 'ring-2 ring-fail/40')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <div className="flex flex-wrap items-center gap-2"><Badge tone="primary">{s.tag}</Badge><span className="text-xs text-muted">{s.seconds}</span></div>
          <h3 className="mt-2 text-lg font-semibold">{s.title}</h3>
          <p className="mt-1 text-sm text-muted">{s.claim}</p>
        </div>
        <div className="flex items-center gap-2">
          {state === 'pass' && <Badge tone="ok">PASS</Badge>}
          {state === 'fail' && <Badge tone="fail">FAIL</Badge>}
          {state === 'error' && <Badge tone="fail">ERROR</Badge>}
          <Button onClick={run} disabled={state === 'running'}>{state === 'running' ? 'Running…' : state === 'idle' ? 'Run' : 'Run again'}</Button>
        </div>
      </div>
      {(lines.length > 0 || error) && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Steps</p>
            <ol className="space-y-0.5 font-mono text-xs" aria-live="polite">{lines.map((l, i) => <li key={i}>{l}</li>)}</ol>
            {error && <p role="alert" className="mt-2 text-sm text-fail">{error}</p>}
            {result && (
              <>
                <p className="mb-1 mt-4 text-xs font-medium uppercase tracking-wide text-muted">Verdict (from database rows)</p>
                <ul className="space-y-1 text-sm">
                  {result.checks.map((c) => (
                    <li key={c.label} className="flex gap-2">
                      <span aria-hidden className={c.ok ? 'text-ok' : 'text-fail'}>{c.ok ? '✔' : '✘'}</span>
                      <span>{c.label}{c.detail && <span className="text-muted"> · {c.detail}</span>}<span className="sr-only">{c.ok ? ' passed' : ' failed'}</span></span>
                    </li>
                  ))}
                </ul>
                {result.extra}
              </>
            )}
          </div>
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">Activity log ({timeline.length} rows)</p>
            <div className="max-h-96 overflow-y-auto pr-2"><Timeline events={timeline} /></div>
          </div>
        </div>
      )}
    </Card>
  );
}

export function DemoLab() {
  const [windowSec, setWindowSec] = useState(10);
  return (
    <>
      <PageTitle title="Delivery verification (internal)">
        Each card drives the real API end to end, then checks the database to decide pass or fail. Developer tool, not part of the product; only served when <Mono>DEMO_MODE=true</Mono>.
      </PageTitle>
      <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-4 text-sm">
        <label htmlFor="win" className="font-medium">KT1 digest window</label>
        <select id="win" className="rounded-lg border border-line bg-surface px-2 py-1" value={windowSec} onChange={(e) => setWindowSec(Number(e.target.value))}>
          <option value={10}>10 seconds (demo)</option><option value={30}>30 seconds</option><option value={300}>5 minutes (as specified)</option>
        </select>
        <span className="text-muted">The engine is identical either way; only the workflow's window setting changes.</span>
      </div>
      <div className="space-y-4">{SCENARIOS.map((s) => <ScenarioCard key={s.id} s={s} windowSec={windowSec} />)}</div>
    </>
  );
}
