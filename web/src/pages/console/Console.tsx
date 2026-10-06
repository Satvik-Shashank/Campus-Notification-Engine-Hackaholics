import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import { admin, session, type ActivityEvent, type Workflow } from '../../api';
import { Logo, Shell, ThemeToggle } from '../../components/Shell';
import {
  Badge, Button, Card, Empty, ErrorNote, Field, Json, Mono, PageTitle, Spinner, Stat, Table, cx, fmtDateTime, fmtTime, inputCls,
  useLoad, useToast,
} from '../../components/ui';
import { Compose } from './Compose';
import { Skyline } from '../../components/Skyline';

function useAdmin() {
  const [, force] = useState(0);
  useEffect(() => session.subscribe(() => force((n) => n + 1)), []);
  return session.adminKey;
}

export function ConsoleApp() {
  const key = useAdmin();
  if (!key) return <ConsoleLogin />;
  return <ConsoleShell />;
}

function ConsoleLogin() {
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const res = await fetch('/admin/workflows', { headers: { authorization: `Bearer ${key}` } });
    if (res.ok) session.setAdminKey(key);
    else setError(res.status === 401 ? 'That API key was not accepted.' : `Server returned ${res.status}.`);
  };
  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden px-4">
      <Skyline className="pointer-events-none absolute inset-x-0 bottom-0 h-56 w-full text-primary/20" />
      <div className="relative w-full max-w-md">
        <div className="mb-6 flex items-center justify-between"><Logo sub="Operator console" /><ThemeToggle /></div>
        <Card title="Operator sign-in">
          <form onSubmit={submit} className="space-y-4">
            <Field label="API key" hint="Held for this browser tab only, never stored permanently." htmlFor="k">
              <input id="k" type="password" className={inputCls} value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" required />
            </Field>
            <ErrorNote error={error} />
            <Button type="submit" className="w-full">Sign in</Button>
            <p className="text-xs text-muted">Local default: <Mono>campus-admin-api-key-change-in-production</Mono></p>
          </form>
        </Card>
      </div>
    </div>
  );
}

function ConsoleShell() {
  const stats = useLoad(() => admin.get<{ deadLettersOpen: number; provider: string }>('/admin/stats'), [], 10000);
  return (
    <Shell
      sub="Operator console"
      nav={[
        { to: '/console', label: 'Overview', end: true },
        { to: '/console/compose', label: 'Compose' },
        { to: '/console/send', label: 'API trigger' },
        { to: '/console/events', label: 'Events' },
        { to: '/console/activity', label: 'Activity' },
        { to: '/console/dead-letters', label: 'Dead letters', badge: stats.data?.deadLettersOpen ? <Badge tone="fail">{stats.data.deadLettersOpen}</Badge> : undefined },
        { to: '/console/providers', label: 'Provider health', badge: stats.data && stats.data.provider !== 'closed' ? <Badge>{stats.data.provider}</Badge> : undefined },
        { to: '/console/workflows', label: 'Workflows' },
        { to: '/console/subscribers', label: 'Subscribers' },
        { to: '/console/webhooks', label: 'Webhooks' },
      ]}
      right={<Button variant="secondary" size="sm" onClick={() => session.setAdminKey(null)}>Sign out</Button>}
    >
      <Routes>
        <Route index element={<Overview />} />
        <Route path="compose" element={<Compose />} />
        <Route path="send" element={<SendEvent />} />
        <Route path="events" element={<Events />} />
        <Route path="activity" element={<Activity />} />
        <Route path="dead-letters" element={<DeadLetters />} />
        <Route path="providers" element={<Providers />} />
        <Route path="workflows" element={<Workflows />} />
        <Route path="subscribers" element={<Subscribers />} />
        <Route path="webhooks" element={<Webhooks />} />
        <Route path="*" element={<Navigate to="/console" replace />} />
      </Routes>
    </Shell>
  );
}

// ---------------------------------------------------------------- overview

interface Stats {
  events: number; messages: number; subscribers: number; deadLettersOpen: number; activeFocusSessions: number; provider: string;
  notifications: Record<string, number>; email: Record<string, number>; inApp: Record<string, number>; queue: Record<string, number>;
  hourly: { hourEnding: string; events: number; messages: number }[];
}

function Overview() {
  const { data, error } = useLoad(() => admin.get<Stats>('/admin/stats'), [], 5000);
  if (!data) return <><PageTitle title="Overview" /><ErrorNote error={error} />{!error && <Spinner />}</>;
  const max = Math.max(1, ...data.hourly.map((h) => h.messages));
  const n = data.notifications;
  return (
    <>
      <PageTitle title="Overview">Last 24 hours across every workflow.</PageTitle>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Events" value={data.events} />
        <Stat label="Messages delivered" value={data.messages} tone="ok" />
        <Stat label="Open dead letters" value={data.deadLettersOpen} tone={data.deadLettersOpen ? 'fail' : undefined} />
        <Stat label="Provider circuit" value={data.provider} tone={data.provider === 'closed' ? 'ok' : 'warn'} />
      </div>
      <Insights />
      <div className="mt-6 grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <Card title="Messages per hour">
          <div className="flex h-40 items-end gap-1" role="img" aria-label="Messages per hour, last 24 hours">
            {data.hourly.map((h) => (
              <div key={h.hourEnding} className="group relative flex-1">
                <div className="rounded-t bg-primary/80" style={{ height: `${Math.max(2, (h.messages / max) * 150)}px` }} />
                <span className="pointer-events-none absolute -top-6 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-ink px-1.5 py-0.5 text-[10px] text-paper group-hover:block">
                  {fmtTime(h.hourEnding)}: {h.messages}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">Each bar is one hour; hover for the count.</p>
        </Card>
        <Card title="Notification outcomes">
          <ul className="space-y-2 text-sm">
            {['sent', 'digested', 'held', 'summarized', 'partially_sent', 'failed', 'processing', 'pending', 'canceled'].map((k) => (
              <li key={k} className="flex items-center justify-between"><Badge>{k}</Badge><span className="tabular-nums">{n[k] ?? 0}</span></li>
            ))}
          </ul>
        </Card>
        <Card title="Channels">
          <Table head={['State', 'Email', 'In-app']} rows={['sent', 'skipped', 'failed', 'retrying', 'deferred', 'summarized', 'pending'].map((k) => [
            <Badge key={k}>{k}</Badge>, data.email[k] ?? 0, data.inApp[k] ?? 0])} />
        </Card>
        <Card title="Queue right now">
          <ul className="space-y-2 text-sm">
            {['queued', 'running', 'retrying', 'delayed'].map((k) => (
              <li key={k} className="flex justify-between"><Badge>{k}</Badge><span className="tabular-nums">{data.queue[k] ?? 0}</span></li>
            ))}
            <li className="flex justify-between border-t border-line pt-2"><span className="text-muted">Subscribers</span><span>{data.subscribers}</span></li>
            <li className="flex justify-between"><span className="text-muted">Students in Focus Mode</span><span>{data.activeFocusSessions}</span></li>
          </ul>
        </Card>
      </div>
    </>
  );
}

// -------------------------------------------------------------- send event

function SendEvent() {
  const toast = useToast();
  const wfs = useLoad(() => admin.get<{ workflows: Workflow[] }>('/admin/workflows'), []);
  const topics = useLoad(() => admin.get<{ topics: { topic: string; members: number }[] }>('/admin/topics'), []);
  const [workflow, setWorkflow] = useState('');
  const [mode, setMode] = useState<'explicit' | 'topic' | 'broadcast'>('explicit');
  const [ids, setIds] = useState('student_001');
  const [topic, setTopic] = useState('');
  const [priority, setPriority] = useState('normal');
  const [txn, setTxn] = useState(() => `evt-${Date.now()}`);
  const [payload, setPayload] = useState('{\n  "exam": "CS101",\n  "room": "H123",\n  "time": "2:00 PM"\n}');
  const [result, setResult] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!workflow && wfs.data?.workflows[0]) setWorkflow(wfs.data.workflows[0].identifier); }, [wfs.data, workflow]);
  useEffect(() => { if (!topic && topics.data?.topics[0]) setTopic(topics.data.topics[0].topic); }, [topics.data, topic]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    let body: unknown;
    try { body = JSON.parse(payload); } catch { setError('Payload must be valid JSON.'); return; }
    try {
      const common = { transactionId: txn, workflowIdentifier: workflow, payload: body, priority };
      const r = mode === 'broadcast'
        ? await admin.post('/events/trigger/broadcast', common)
        : await admin.post('/events/trigger', {
          ...common,
          to: mode === 'topic' ? { type: 'topic', topic } : { type: 'explicit', subscriberIds: ids.split(/[\s,]+/).filter(Boolean) },
        });
      setResult(r);
      toast('ok', `Accepted ${txn}`);
      setTxn(`evt-${Date.now()}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <>
      <PageTitle title="Send event">Submit an event the way a registrar system would. The API answers 202 immediately and delivery happens in the background.</PageTitle>
      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card>
          <form onSubmit={submit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Workflow" htmlFor="wf">
                <select id="wf" className={inputCls} value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
                  {wfs.data?.workflows.map((w) => <option key={w.identifier} value={w.identifier}>{w.identifier}{w.critical ? ' (critical)' : ''}</option>)}
                </select>
              </Field>
              <Field label="Priority" htmlFor="pr">
                <select id="pr" className={inputCls} value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option value="normal">normal</option><option value="critical">critical (bypasses Focus Mode)</option>
                </select>
              </Field>
            </div>
            <fieldset>
              <legend className="mb-1 text-xs font-medium text-muted">Recipients</legend>
              <div className="flex gap-2">
                {(['explicit', 'topic', 'broadcast'] as const).map((m) => (
                  <button type="button" key={m} onClick={() => setMode(m)} aria-pressed={mode === m}
                    className={cx('rounded-lg px-3 py-1.5 text-sm', mode === m ? 'bg-primary text-primary-ink' : 'border border-line hover:bg-sunken')}>
                    {m === 'explicit' ? 'Students' : m === 'topic' ? 'Topic' : 'Everyone'}
                  </button>
                ))}
              </div>
              <div className="mt-3">
                {mode === 'explicit' && <Field label="Student IDs (comma or space separated, max 100)" htmlFor="ids"><input id="ids" className={inputCls} value={ids} onChange={(e) => setIds(e.target.value)} /></Field>}
                {mode === 'topic' && (
                  <Field label="Topic" htmlFor="tp">
                    <select id="tp" className={inputCls} value={topic} onChange={(e) => setTopic(e.target.value)}>
                      {topics.data?.topics.map((t) => <option key={t.topic} value={t.topic}>{t.topic} ({t.members})</option>)}
                    </select>
                  </Field>
                )}
                {mode === 'broadcast' && <p className="text-sm text-muted">Every subscriber on campus will receive this.</p>}
              </div>
            </fieldset>
            <Field label="Transaction ID (idempotency key)" hint="Re-sending the same ID within 24 h returns the first response and creates nothing new." htmlFor="tx">
              <input id="tx" className={cx(inputCls, 'font-mono')} value={txn} onChange={(e) => setTxn(e.target.value)} />
            </Field>
            <Field label="Payload (JSON)" htmlFor="pl"><textarea id="pl" rows={7} className={cx(inputCls, 'font-mono text-xs')} value={payload} onChange={(e) => setPayload(e.target.value)} /></Field>
            <ErrorNote error={error} />
            <Button type="submit">Send event</Button>
          </form>
        </Card>
        <Card title="Response">
          {result ? (
            <>
              <Json value={result} />
              <Link className="mt-3 inline-block text-sm text-primary underline" to={`/console/events?open=${encodeURIComponent((result as { transactionId?: string }).transactionId ?? '')}`}>Track delivery →</Link>
            </>
          ) : <p className="text-sm text-muted">Send an event to see the 202 response.</p>}
        </Card>
      </div>
    </>
  );
}

// -------------------------------------------------------------------- events

interface EventRow {
  transactionId: string; workflowId: string; status: string; priority: string; recipientType: string; recipientCount: number;
  submittedAt: string; notifications: Record<string, number>; lastError: string | null; payload: unknown;
}

function Events() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState('');
  const open = params.get('open');
  const { data, error } = useLoad(() => admin.get<{ total: number; events: EventRow[] }>(`/admin/events?limit=100&q=${encodeURIComponent(q)}`), [q], 4000);
  return (
    <>
      <PageTitle title="Events">Every accepted trigger. Open one to see per-channel results and its full activity trail.</PageTitle>
      <div className="mb-4"><input aria-label="Search transaction id" className={cx(inputCls, 'max-w-sm')} placeholder="Search transaction id" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <ErrorNote error={error} />
      {!data ? <Spinner /> : (
        <Table
          head={['Transaction', 'Workflow', 'Recipients', 'Outcome', 'Submitted', '']}
          rows={data.events.map((e) => [
            <Mono key="t">{e.transactionId}</Mono>,
            <span key="w">{e.workflowId} {e.priority === 'critical' && <Badge>critical</Badge>}</span>,
            `${e.recipientCount} (${e.recipientType})`,
            <span key="o" className="flex flex-wrap gap-1">{e.status !== 'processed' && <Badge>{e.status}</Badge>}{Object.entries(e.notifications).map(([k, v]) => <Badge key={k}>{`${k} ${v}`}</Badge>)}</span>,
            fmtDateTime(e.submittedAt),
            <Button key="b" variant="ghost" size="sm" onClick={() => setParams({ open: e.transactionId })}>Details</Button>,
          ])}
          empty="No events yet. Send one from “Send event”."
        />
      )}
      {open && <EventDrawer txn={open} onClose={() => setParams({})} />}
    </>
  );
}

function EventDrawer({ txn, onClose }: { txn: string; onClose: () => void }) {
  const toast = useToast();
  const status = useLoad(() => admin.get<{ status: string; recipientStats: Record<string, number>; workflowId: string; lastError?: string }>(`/admin/notifications/${encodeURIComponent(txn)}`), [txn], 2000);
  const act = useLoad(() => admin.get<{ events: ActivityEvent[] }>(`/admin/activity?limit=500&transactionId=${encodeURIComponent(txn)}`), [txn], 2000);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const cancel = async () => {
    try {
      const r = await admin.del<{ canceledJobCount: number }>(`/events/trigger/${encodeURIComponent(txn)}`);
      toast('ok', `Canceled ${r.canceledJobCount} pending job(s)`);
    } catch (e) { toast('fail', (e as Error).message); }
  };
  const s = status.data?.recipientStats;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ink/30" onClick={onClose}>
      <aside role="dialog" aria-modal="true" aria-label={`Event ${txn}`} className="h-full w-full max-w-xl overflow-y-auto bg-paper p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-2">
          <div><p className="text-xs text-muted">Event</p><h2 className="font-mono text-sm font-semibold break-all">{txn}</h2></div>
          <Button variant="secondary" size="sm" onClick={onClose} aria-label="Close">Close</Button>
        </div>
        {status.data && (
          <Card title={<span className="flex items-center gap-2">Delivery <Badge>{status.data.status}</Badge></span>} actions={<Button variant="danger" size="sm" onClick={cancel}>Cancel pending</Button>}>
            {status.data.lastError && <ErrorNote error={status.data.lastError} />}
            {s && (
              <Table head={['', 'Sent', 'Skipped', 'Failed', 'Held']} rows={[
                ['Email', s.emailSent, s.emailSkipped, s.emailFailed, s.emailDeferred],
                ['In-app', s.inAppSent, s.inAppSkipped, s.inAppFailed, s.inAppDeferred],
              ]} />
            )}
            {s && <p className="mt-2 text-xs text-muted">{s.total} notification(s) · {s.digested} merged into a digest · {s.held} held by Focus Mode</p>}
          </Card>
        )}
        <Recipients txn={txn} />
        <div className="mt-4"><Card title="Activity"><Timeline events={act.data?.events ?? []} /></Card></div>
      </aside>
    </div>
  );
}

export function Timeline({ events }: { events: ActivityEvent[] }) {
  if (!events.length) return <p className="text-sm text-muted">No activity yet.</p>;
  return (
    <ol className="relative space-y-3 border-l border-line pl-4">
      {events.map((e, i) => (
        <li key={i} className="relative">
          <span className={cx('absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-paper',
            e.status === 'success' ? 'bg-ok' : e.status === 'failure' ? 'bg-fail' : e.status === 'skipped' ? 'bg-muted' : 'bg-info')} />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Mono className="font-medium">{e.event}</Mono>
            {e.attempt != null && <Badge tone="muted">attempt {e.attempt}</Badge>}
            {e.subscriberId && <span className="text-xs text-muted">{e.subscriberId}</span>}
            <span className="ml-auto text-xs text-muted">{fmtTime(e.timestamp ?? e.at)}</span>
          </div>
          {e.details && <p className="text-xs text-muted">{e.details}</p>}
        </li>
      ))}
    </ol>
  );
}

// ------------------------------------------------------------------ activity

function Activity() {
  const [f, setF] = useState({ transactionId: '', subscriberId: '', workflowId: '', status: '' });
  const qs = new URLSearchParams(Object.entries({ ...f, limit: '200' }).filter(([, v]) => v)).toString();
  const { data, error } = useLoad(() => admin.get<{ total: number; events: ActivityEvent[] }>(`/admin/activity?${qs}`), [qs], 5000);
  return (
    <>
      <PageTitle title="Activity">The audit trail: every step, attempt, retry, skip and hold.</PageTitle>
      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        {(['transactionId', 'subscriberId', 'workflowId'] as const).map((k) => (
          <input key={k} aria-label={k} className={inputCls} placeholder={k} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
        ))}
        <select aria-label="status" className={inputCls} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="">any status</option>{['success', 'failure', 'skipped', 'info'].map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      <ErrorNote error={error} />
      {data && (
        <Table head={['Time', 'Event', 'Status', 'Subscriber', 'Workflow', 'Details']} rows={data.events.slice().reverse().map((e) => [
          fmtTime(e.timestamp), <Mono key="e">{e.event}</Mono>, <Badge key="s">{e.status}</Badge>, e.subscriberId ?? '—', e.workflowId ?? '—',
          <span key="d" className="text-xs text-muted">{e.details}{e.attempt != null ? ` (attempt ${e.attempt})` : ''}</span>,
        ])} empty="No matching activity." />
      )}
    </>
  );
}

// -------------------------------------------------------------- dead letters

interface Letter { id: number; status: string; channel: string; reason: string; lastError: string; attempts: number; transactionId: string; subscriberId: string; workflowId: string; createdAt: string }

function DeadLetters() {
  const toast = useToast();
  const [status, setStatus] = useState('open');
  const { data, error, reload } = useLoad(() => admin.get<{ total: number; deadLetters: Letter[] }>(`/admin/dead-letters?status=${status}&limit=200`), [status], 5000);
  const act = async (path: string, ok: string) => {
    try { await admin.post(path); toast('ok', ok); reload(); } catch (e) { toast('fail', (e as Error).message); }
  };
  return (
    <>
      <PageTitle title="Dead letters">Deliveries that failed for good (permanent error or retries used up). Retrying re-queues the same job with the same idempotency key, so it can never cause a duplicate.</PageTitle>
      <div className="mb-4 flex gap-2">
        {['open', 'retried', 'dismissed'].map((s) => (
          <button key={s} onClick={() => setStatus(s)} aria-pressed={status === s} className={cx('rounded-full px-3 py-1 text-sm capitalize', status === s ? 'bg-primary text-primary-ink' : 'border border-line hover:bg-sunken')}>{s}</button>
        ))}
      </div>
      <ErrorNote error={error} />
      {data && (
        <Table head={['Failed', 'Event', 'Student', 'Channel', 'Reason', 'Attempts', '']} rows={data.deadLetters.map((l) => [
          fmtDateTime(l.createdAt), <Mono key="t">{l.transactionId}</Mono>, l.subscriberId, l.channel,
          <span key="r"><Badge tone="fail">{l.reason}</Badge><span className="mt-1 block text-xs text-muted">{l.lastError}</span></span>, l.attempts,
          l.status === 'open' ? (
            <span key="a" className="flex gap-1">
              <Button size="sm" onClick={() => act(`/admin/dead-letters/${l.id}/retry`, 'Re-queued')}>Retry</Button>
              <Button size="sm" variant="secondary" onClick={() => act(`/admin/dead-letters/${l.id}/dismiss`, 'Dismissed')}>Dismiss</Button>
            </span>
          ) : <Badge key="s">{l.status}</Badge>,
        ])} empty={status === 'open' ? 'No failed deliveries waiting. 🎉' : 'Nothing here.'} />
      )}
    </>
  );
}

// ----------------------------------------------------------------- providers

interface ProviderSnap {
  provider: string; lastError: string | null; lastErrorAt: string | null;
  breaker: { state: string; consecutiveFailures: number; threshold: number; cooldownMs: number; openedAt: string | null; reopensProbeAt: string | null };
  rateLimit: { enabled: boolean; ratePerSec: number; tokens: number | null; capacity: number; pausedUntil: string | null };
  counters: { sent: number; failed: number; throttled: number; rejectedOpen: number };
}

function Providers() {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => admin.get<{ email: ProviderSnap }>('/admin/providers'), [], 2000);
  const p = data?.email;
  return (
    <>
      <PageTitle title="Provider health">The email provider sits behind a rate limiter and a circuit breaker, so a provider outage holds mail instead of burning every student's retry budget.</PageTitle>
      <ErrorNote error={error} />
      {!p ? <Spinner /> : (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title={<span className="flex items-center gap-2">Circuit breaker <Badge>{p.breaker.state}</Badge></span>}
            actions={<Button size="sm" variant="secondary" onClick={async () => { await admin.post('/admin/providers/email/reset'); toast('ok', 'Breaker reset'); reload(); }}>Reset</Button>}>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <dt className="text-muted">Provider</dt><dd><Mono>{p.provider}</Mono></dd>
              <dt className="text-muted">Consecutive failures</dt><dd>{p.breaker.consecutiveFailures} / {p.breaker.threshold}</dd>
              <dt className="text-muted">Opened at</dt><dd>{fmtTime(p.breaker.openedAt)}</dd>
              <dt className="text-muted">Next probe</dt><dd>{fmtTime(p.breaker.reopensProbeAt)}</dd>
              <dt className="text-muted">Last error</dt><dd className="text-fail">{p.lastError ?? '—'}</dd>
            </dl>
          </Card>
          <Card title="Rate limit">
            {p.rateLimit.enabled ? (
              <>
                <p className="text-sm">{p.rateLimit.ratePerSec} emails / second</p>
                <div className="mt-3 h-3 overflow-hidden rounded-full bg-sunken" role="meter" aria-valuemin={0} aria-valuemax={p.rateLimit.capacity} aria-valuenow={p.rateLimit.tokens ?? 0} aria-label="Tokens available">
                  <div className="h-full bg-primary" style={{ width: `${((p.rateLimit.tokens ?? 0) / p.rateLimit.capacity) * 100}%` }} />
                </div>
                <p className="mt-1 text-xs text-muted">{p.rateLimit.tokens} of {p.rateLimit.capacity} tokens available{p.rateLimit.pausedUntil ? ` · paused by provider until ${fmtTime(p.rateLimit.pausedUntil)}` : ''}</p>
              </>
            ) : <p className="text-sm text-muted">Disabled (EMAIL_RATE_PER_SEC=0).</p>}
          </Card>
          <Card title="Counters (since start)" className="lg:col-span-2">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Sent" value={p.counters.sent} tone="ok" />
              <Stat label="Failed attempts" value={p.counters.failed} tone={p.counters.failed ? 'fail' : undefined} />
              <Stat label="Throttled (no attempt used)" value={p.counters.throttled} />
              <Stat label="Held by open circuit" value={p.counters.rejectedOpen} />
            </div>
          </Card>
        </div>
      )}
    </>
  );
}

// ----------------------------------------------------------------- workflows

function Workflows() {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => admin.get<{ workflows: Workflow[] }>('/admin/workflows'), []);
  const [editing, setEditing] = useState<{ id: string; json: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const blank = { steps: [{ type: 'email', subject: 'Subject {{field}}', body: 'Body {{field}}' }, { type: 'in-app', subject: 'Subject {{field}}', body: 'Body {{field}}' }] };
  const save = async () => {
    if (!editing) return;
    setErr(null);
    let def: unknown;
    try { def = JSON.parse(editing.json); } catch { setErr('Definition must be valid JSON.'); return; }
    try { await admin.put(`/admin/workflows/${encodeURIComponent(editing.id)}`, def); toast('ok', `Saved ${editing.id}`); setEditing(null); reload(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <>
      <PageTitle title="Workflows">Each workflow is an ordered chain: an optional digest, then email and/or in-app steps.</PageTitle>
      <div className="mb-4"><Button onClick={() => setEditing({ id: 'new-workflow', json: JSON.stringify(blank, null, 2) })}>New workflow</Button></div>
      <ErrorNote error={error} />
      <div className="grid gap-4 lg:grid-cols-2">
        {data?.workflows.map((w) => (
          <Card key={w.identifier} title={<span className="flex items-center gap-2 text-sm">{(w as Workflow & { name?: string }).name ?? w.identifier}{w.critical && <Badge tone="accent">critical</Badge>}</span>}
            actions={<Button size="sm" variant="secondary" onClick={() => { const x = w as Workflow & Record<string, unknown>; setEditing({ id: w.identifier, json: JSON.stringify({ name: x.name, description: x.description, category: x.category, priority: x.priority, critical: w.critical, correlationKey: w.correlationKey ?? undefined, criticalRules: w.criticalRules, primaryAction: x.primaryAction ?? undefined, secondaryAction: x.secondaryAction ?? undefined, steps: w.steps }, null, 2) }); }}>Edit</Button>}>
            <p className="-mt-2 mb-4 text-xs text-muted"><Mono>{w.identifier}</Mono> · {String((w as Workflow & { category?: string }).category ?? '')} · priority {String((w as Workflow & { priority?: string }).priority ?? 'normal')}</p>
            <WorkflowFlow w={w} />
            {(w.correlationKey || w.criticalRules.length > 0) && (
              <p className="mt-3 text-xs text-muted">
                {w.correlationKey && <>Focus correlation: <Mono>{w.correlationKey}</Mono>. </>}
                {w.criticalRules.length > 0 && <>Critical when {(w.criticalRules as { field: string; op: string; value: unknown }[]).map((r) => `${r.field} ${r.op} ${String(r.value)}`).join(' or ')}.</>}
              </p>
            )}
          </Card>
        ))}
      </div>
      {editing && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-ink/30 p-4" onClick={() => setEditing(null)}>
          <div role="dialog" aria-modal="true" aria-label="Edit workflow" className="w-full max-w-2xl rounded-xl bg-paper p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-4 text-lg font-semibold">Edit workflow</h2>
            <div className="space-y-3">
              <Field label="Identifier" htmlFor="wid"><input id="wid" className={cx(inputCls, 'font-mono')} value={editing.id} onChange={(e) => setEditing({ ...editing, id: e.target.value })} /></Field>
              <Field label="Definition (JSON)" hint='Step types: digest {windowMs, digestKey, groupScope?} · email / in-app {subject, body} with {{field}} placeholders. Optional: critical, correlationKey, criticalRules [{field, op: lt|lte|gt|gte|eq, value}].' htmlFor="wdef">
                <textarea id="wdef" rows={16} className={cx(inputCls, 'font-mono text-xs')} value={editing.json} onChange={(e) => setEditing({ ...editing, json: e.target.value })} />
              </Field>
              <ErrorNote error={err} />
              <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button onClick={save}>Save</Button></div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// --------------------------------------------------------------- subscribers

function Subscribers() {
  const toast = useToast();
  const [q, setQ] = useState('');
  const { data, error, reload } = useLoad(() => admin.get<{ total: number; subscribers: { subscriberId: string; email: string; topics: string[]; createdAt: string }[] }>(`/admin/subscribers?limit=200&q=${encodeURIComponent(q)}`), [q]);
  const [form, setForm] = useState({ id: '', email: '', topic: '' });
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await admin.put(`/admin/subscribers/${encodeURIComponent(form.id)}`, { email: form.email || undefined });
      if (form.topic) await admin.put(`/admin/topics/${encodeURIComponent(form.topic)}/subscribers`, { subscriberIds: [form.id] });
      toast('ok', `Saved ${form.id}`);
      setForm({ id: '', email: '', topic: '' });
      reload();
    } catch (err) { toast('fail', (err as Error).message); }
  };
  return (
    <>
      <PageTitle title="Subscribers">Students who can receive notifications, and the topics they belong to.</PageTitle>
      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <div>
          <input aria-label="Search" className={cx(inputCls, 'mb-4 max-w-sm')} placeholder="Search id or email" value={q} onChange={(e) => setQ(e.target.value)} />
          <ErrorNote error={error} />
          {data && <><p className="mb-2 text-xs text-muted">{data.total} total</p>
            <Table head={['Student', 'Email', 'Topics']} rows={data.subscribers.map((s) => [<Mono key="i">{s.subscriberId}</Mono>, s.email ?? '—', s.topics.map((t) => <Badge key={t} tone="primary">{t}</Badge>)])} /></>}
        </div>
        <Card title="Add or update a student">
          <form onSubmit={add} className="space-y-3">
            <Field label="Student ID" htmlFor="ns"><input id="ns" required className={inputCls} value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} /></Field>
            <Field label="Email" htmlFor="ne"><input id="ne" type="email" className={inputCls} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
            <Field label="Add to topic (optional)" htmlFor="nt"><input id="nt" className={inputCls} value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })} /></Field>
            <Button type="submit">Save</Button>
          </form>
        </Card>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ webhooks

function Webhooks() {
  const { data, error } = useLoad(() => admin.get<{
    providers: { provider: string; scheme: string; secretConfigured: boolean; allowUnverified: boolean }[];
    total: number; webhooks: { id: number; provider: string; verification: string; outcome: string; applied: number; receivedAt: string }[];
  }>('/admin/webhooks'), [], 5000);
  return (
    <>
      <PageTitle title="Inbound webhooks">Provider delivery callbacks are trusted only when their signature verifies. Everything else is rejected and recorded here.</PageTitle>
      <ErrorNote error={error} />
      {data && (
        <div className="space-y-6">
          <Card title="Providers">
            <Table head={['Provider', 'Verification', 'Secret', 'Unverified opt-in']} rows={data.providers.map((p) => [
              <Mono key="p">{p.provider}</Mono>, p.scheme, p.secretConfigured ? <Badge tone="ok">configured</Badge> : <Badge tone="warn">not set</Badge>,
              p.allowUnverified ? <Badge tone="warn">recorded, never applied</Badge> : 'off',
            ])} />
          </Card>
          <Card title={`Received (${data.total})`}>
            <Table head={['Time', 'Provider', 'Verification', 'Outcome', 'Applied']} rows={data.webhooks.map((w) => [
              fmtDateTime(w.receivedAt), <Mono key="p">{w.provider}</Mono>, <Badge key="v">{w.verification}</Badge>, <Badge key="o">{w.outcome}</Badge>, w.applied,
            ])} empty="No webhooks received yet." />
          </Card>
        </div>
      )}
      {!data && !error && <Empty title="Loading…" />}
    </>
  );
}

// ------------------------------------------------------------- workflow flow

function WorkflowFlow({ w }: { w: Workflow }) {
  const digest = w.steps.find((s) => s.type === 'digest');
  const channels = w.steps.filter((s) => s.type !== 'digest').map((s) => String(s.type));
  const x = w as Workflow & { priority?: string };
  const stages: [string, string, string?][] = [
    ['Event', (w as Workflow & { name?: string }).name ?? w.identifier],
    ['Audience', 'Chosen when publishing'],
    ['Rules', w.critical ? 'Critical: ignores mutes and Focus Mode' : w.criticalRules.length ? `Critical when ${(w.criticalRules as { field: string; op: string; value: unknown }[]).map((r) => `${r.field} ${r.op} ${String(r.value)}`).join(' or ')}` : 'Respects preferences and Focus Mode'],
    ['Timing', digest ? `Combine related updates for ${Math.round(Number(digest.windowMs) / 60000)} min${digest.groupScope ? ` (group ${String(digest.groupScope)})` : ''}` : 'Immediately'],
    ['Channels', channels.map((c) => (c === 'in-app' ? 'In-app' : 'Email')).join(' then ')],
    ['Priority', x.priority ?? 'normal', x.priority === 'critical' ? 'accent' : x.priority === 'high' ? 'warn' : undefined],
  ];
  return (
    <ol className="relative space-y-2 border-l border-line pl-4 text-sm">
      {stages.map(([k, v, tone]) => (
        <li key={k} className="relative">
          <span className={cx('absolute -left-[21px] top-1.5 h-2 w-2 rounded-full ring-4 ring-surface', tone === 'accent' ? 'bg-accent' : k === 'Timing' && digest ? 'bg-primary' : 'bg-line')} />
          <span className="inline-block w-20 text-xs text-muted">{k}</span><span className={cx(tone === 'accent' && 'font-medium text-accent', tone === 'warn' && 'text-warn')}>{v}</span>
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------- insights

interface InsightsData {
  days: number;
  attention: { notifications: number; deliveredImmediately: number; combinedIntoDigests: number; digestsSent: number; heldByFocus: number; criticalBypassedFocus: number; suppressedAsRedundant: number; critical: number };
  engagement: { inAppDelivered: number; read: number; clicked: number; readRate: number; clickRate: number };
  channels: { inApp: number; email: number; emailSkippedByPreference: number };
  byCategory: { category: string; notifications: number; read: number }[];
  daily: { dayEnding: string; notifications: number; delivered: number }[];
}

function Insights() {
  const { data } = useLoad(() => admin.get<InsightsData>('/admin/insights?days=7'), [], 15000);
  if (!data) return null;
  const a = data.attention;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const bars: [string, number, string][] = [
    ['Delivered immediately', a.deliveredImmediately, 'bg-primary'],
    ['Combined into digests', a.combinedIntoDigests, 'bg-info'],
    ['Held by Focus Mode', a.heldByFocus, 'bg-accent/70'],
    ['Suppressed as redundant', a.suppressedAsRedundant, 'bg-muted'],
    ['Critical (bypassed limits)', a.critical, 'bg-accent'],
  ];
  const max = Math.max(1, ...bars.map((b) => b[1]));
  const dmax = Math.max(1, ...data.daily.map((d) => d.delivered));
  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-[1.2fr_1fr]">
      <Card title="Attention management · last 7 days">
        <p className="-mt-2 mb-4 text-xs text-muted">How {a.notifications.toLocaleString()} notifications reached students without demanding attention every time. {a.digestsSent} digest{a.digestsSent === 1 ? '' : 's'} replaced {a.combinedIntoDigests} separate messages.</p>
        <ul className="space-y-2.5">
          {bars.map(([label, v, color]) => (
            <li key={label} className="grid grid-cols-[170px_1fr_48px] items-center gap-3 text-sm">
              <span className="text-muted">{label}</span>
              <span className="h-2 overflow-hidden rounded-full bg-sunken"><span className={cx('block h-full rounded-full', color)} style={{ width: `${(v / max) * 100}%` }} /></span>
              <span className="text-right tabular-nums">{v.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Engagement · last 7 days">
        <div className="grid grid-cols-3 gap-3">
          <div><p className="text-xs text-muted">In-app delivered</p><p className="text-xl font-semibold tabular-nums">{data.engagement.inAppDelivered.toLocaleString()}</p></div>
          <div><p className="text-xs text-muted">Read</p><p className="text-xl font-semibold tabular-nums">{pct(data.engagement.readRate)}</p></div>
          <div><p className="text-xs text-muted">Action clicked</p><p className="text-xl font-semibold tabular-nums">{pct(data.engagement.clickRate)}</p></div>
        </div>
        <div className="mt-4 flex h-16 items-end gap-1.5" role="img" aria-label="Messages delivered per day">
          {data.daily.map((d) => <div key={d.dayEnding} title={`${new Date(d.dayEnding).toLocaleDateString()}: ${d.delivered}`} className="flex-1 rounded-t bg-primary/70" style={{ height: `${Math.max(2, (d.delivered / dmax) * 60)}px` }} />)}
        </div>
        <p className="mt-1 text-xs text-muted">Messages delivered per day</p>
        <ul className="mt-4 space-y-1 text-sm">
          {data.byCategory.map((c) => (
            <li key={c.category} className="flex justify-between"><span className="capitalize text-muted">{c.category}</span><span className="tabular-nums">{c.notifications} · {c.notifications ? pct(c.read / c.notifications) : '0%'} read</span></li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted">Email: {data.channels.email.toLocaleString()} sent, {data.channels.emailSkippedByPreference.toLocaleString()} skipped by student preference.</p>
      </Card>
    </div>
  );
}

// -------------------------------------------------------- recipients + lifecycle

interface Stage { key: string; label: string; state: 'done' | 'active' | 'waiting' | 'skipped' | 'failed'; at: string | null; detail: string }

function Recipients({ txn }: { txn: string }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const list = useLoad(() => admin.get<{ recipients: { notificationId: number; subscriberId: string; name: string; status: string; email: string; inApp: string; read: boolean }[] }>(`/admin/events/${encodeURIComponent(txn)}/recipients?q=${encodeURIComponent(q)}`), [txn, q], 4000);
  const life = useLoad(() => (open ? admin.get<{ student: { id: string; name: string }; workflow: string; stages: Stage[] }>(`/admin/deliveries/${open}`) : Promise.resolve(null)), [open], 3000);
  return (
    <div className="mt-4">
      <Card title="Students">
        <input aria-label="Search students" className={cx(inputCls, 'mb-3')} placeholder="Search by name or ID" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-md border border-line text-sm">
          {list.data?.recipients.map((r) => (
            <li key={r.notificationId}>
              <button onClick={() => setOpen(r.notificationId)} className={cx('flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-sunken', open === r.notificationId && 'bg-sunken')}>
                <span className="min-w-0 flex-1 truncate">{r.name || r.subscriberId} <span className="text-xs text-muted">{r.subscriberId}</span></span>
                <Badge>{r.status}</Badge>{r.read && <span className="text-xs text-ok">read</span>}
              </button>
            </li>
          ))}
          {list.data && list.data.recipients.length === 0 && <li className="px-3 py-4 text-muted">No students yet.</li>}
        </ul>
      </Card>
      {life.data && (
        <div className="mt-4">
          <Card title={`Lifecycle · ${life.data.student.name || life.data.student.id}`}>
            <ol className="relative space-y-3 border-l border-line pl-5">
              {life.data.stages.map((st) => (
                <li key={st.key} className="cne-fade relative">
                  <span className={cx('absolute -left-[26px] top-1 grid h-3 w-3 place-items-center rounded-full ring-4 ring-surface',
                    st.state === 'done' ? 'bg-ok' : st.state === 'failed' ? 'bg-fail' : st.state === 'active' ? 'bg-warn' : st.state === 'skipped' ? 'bg-muted' : 'bg-line')} />
                  <div className="flex items-baseline justify-between gap-2"><p className="text-sm font-medium">{st.label}</p><span className="text-xs text-muted">{st.at ? fmtTime(st.at) : ''}</span></div>
                  <p className="text-xs text-muted">{st.state === 'skipped' ? 'Skipped · ' : st.state === 'waiting' ? 'Waiting · ' : st.state === 'active' ? 'In progress · ' : st.state === 'failed' ? 'Failed · ' : ''}{st.detail}</p>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      )}
    </div>
  );
}
