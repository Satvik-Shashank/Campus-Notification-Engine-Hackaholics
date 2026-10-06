import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Inbox as InboxIcon, Layers, Mail, Plus, Users, X } from 'lucide-react';
import { admin, type Workflow } from '../../api';
import { Button, ErrorNote, Field, cx, inputCls, useLoad, useToast } from '../../components/ui';

interface Group { key: string; name: string; description: string | null; kind: string; members: number }
interface Wf extends Workflow { name: string; description: string; category: string; priority: string; primaryAction: { label: string; url: string | null } | null; secondaryAction: { label: string; url: string | null } | null }
interface ChangeRow { label: string; from: string; to: string }

const KIND_ORDER = ['department', 'year', 'course', 'club', 'residence', 'service', 'interest'];
const KIND_LABEL: Record<string, string> = { department: 'Department', year: 'Year', course: 'Course', club: 'Club', residence: 'Residence', service: 'Service', interest: 'Interest' };
const CAT_LABEL: Record<string, string> = { academic: 'Academic', campus: 'Campus', events: 'Events', administrative: 'Administrative', clubs: 'Clubs & Activities' };
const fill = (t: string, p: Record<string, string>) => t.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, k) => p[k] ?? '');

/** Event composer: everything the admin chooses here flows through the real trigger API. */
export function Compose() {
  const toast = useToast();
  const wfs = useLoad(() => admin.get<{ workflows: Wf[] }>('/admin/workflows'), []);
  const groups = useLoad(() => admin.get<{ everyone: number; groups: Group[] }>('/admin/audiences'), []);
  const [wfId, setWfId] = useState('');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [priority, setPriority] = useState('');
  const [everyone, setEveryone] = useState(false);
  const [audience, setAudience] = useState<string[]>([]);
  const [changes, setChanges] = useState<ChangeRow[]>([]);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [estimate, setEstimate] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ transactionId: string; recipientCount: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickerKind, setPickerKind] = useState('course');

  useEffect(() => { if (!wfId && wfs.data?.workflows.length) setWfId(wfs.data.workflows.find((w) => w.identifier === 'exam-schedule-change')?.identifier ?? wfs.data.workflows[0].identifier); }, [wfs.data, wfId]);
  const wf = wfs.data?.workflows.find((w) => w.identifier === wfId);
  const effPriority = priority || wf?.priority || 'normal';
  const isCritical = effPriority === 'critical' || !!wf?.critical;
  const digest = wf?.steps.find((s) => s.type === 'digest') as { windowMs?: number } | undefined;
  const channels = (wf?.steps ?? []).filter((s) => s.type !== 'digest').map((s) => String(s.type));
  // Template variables the workflow's actions use (e.g. {{course}}), so the admin can fill them.
  const vars = useMemo(() => {
    const set = new Set<string>();
    for (const a of [wf?.primaryAction, wf?.secondaryAction]) for (const m of `${a?.label ?? ''} ${a?.url ?? ''}`.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) set.add(m[1]);
    if (digest && (wf?.steps[0] as { digestKey?: string })?.digestKey) set.add(String((wf?.steps[0] as { digestKey?: string }).digestKey));
    return [...set].filter((v) => !['title', 'summary'].includes(v));
  }, [wf, digest]);

  useEffect(() => {
    const t = setTimeout(async () => {
      if (everyone) { setEstimate(groups.data?.everyone ?? null); return; }
      if (!audience.length) { setEstimate(0); return; }
      const r = await admin.post<{ students: number }>('/admin/audiences/estimate', { topics: audience });
      setEstimate(r.students);
    }, 150);
    return () => clearTimeout(t);
  }, [audience, everyone, groups.data]);

  const payload = { title, summary, ...fields, ...(changes.length ? { changes: changes.filter((c) => c.label && c.to) } : {}) };
  const groupName = (k: string) => groups.data?.groups.find((g) => g.key === k)?.name ?? k;
  const canSend = !!wf && title.trim() && summary.trim() && (everyone || audience.length > 0) && !busy;

  const publish = async () => {
    setError(null); setBusy(true);
    try {
      const transactionId = `${wfId}-${Date.now().toString(36)}`;
      const body = { transactionId, workflowIdentifier: wfId, payload, priority: priority || undefined };
      const r = everyone
        ? await admin.post<{ transactionId: string; recipientCount: number }>('/events/trigger/broadcast', body)
        : await admin.post<{ transactionId: string; recipientCount: number }>('/events/trigger', { ...body, to: { type: 'topic', topics: audience } });
      setSent(r);
      toast('ok', `Published to ${r.recipientCount.toLocaleString()} students`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  if (sent) {
    return (
      <div className="cne-fade mx-auto max-w-lg py-16 text-center">
        <p className="text-sm text-muted">Published</p>
        <h1 className="mt-1 text-2xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted">Queued for {sent.recipientCount.toLocaleString()} students. Delivery happens in the background{digest ? `, combined with related updates for ${Math.round((digest.windowMs ?? 0) / 60000)} minutes` : ''}.</p>
        <div className="mt-6 flex justify-center gap-2">
          <Link to={`/console/events?open=${encodeURIComponent(sent.transactionId)}`} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-ink">Track delivery</Link>
          <Button variant="secondary" onClick={() => { setSent(null); setTitle(''); setSummary(''); setChanges([]); }}>Compose another</Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Compose</h1>
        <p className="mt-1 text-sm text-muted">Publish a campus event. The workflow decides timing, channels and grouping; you decide what happened and who it affects.</p>
      </div>
      <div className="grid gap-8 xl:grid-cols-[1fr_400px]">
        <div className="space-y-8">
          <section>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">1 · What kind of event</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {wfs.data?.workflows.map((w) => (
                <button key={w.identifier} type="button" onClick={() => { setWfId(w.identifier); setPriority(''); }}
                  className={cx('rounded-lg border px-3 py-2.5 text-left transition-colors', w.identifier === wfId ? 'border-primary bg-primary-soft/50' : 'border-line bg-surface hover:border-ink/20')}>
                  <p className="flex items-center gap-2 text-sm font-medium">{w.name}{w.critical && <AlertTriangle size={13} className="text-accent" />}</p>
                  <p className="mt-0.5 line-clamp-1 text-xs text-muted">{CAT_LABEL[w.category] ?? w.category} · {w.description}</p>
                </button>
              ))}
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">2 · Message</h2>
            <Field label="Title" htmlFor="ct"><input id="ct" className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. DBMS end-semester exam rescheduled" /></Field>
            <Field label="Summary" hint="One or two plain sentences. Students see this first." htmlFor="cs"><textarea id="cs" rows={3} className={inputCls} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Time moved from 10:00 AM to 2:00 PM; room is now AB3-204." /></Field>
            {vars.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2">
                {vars.map((v) => <Field key={v} label={v} htmlFor={`v-${v}`}><input id={`v-${v}`} className={inputCls} value={fields[v] ?? ''} onChange={(e) => setFields({ ...fields, [v]: e.target.value })} placeholder={v === 'course' ? 'CS301' : ''} /></Field>)}
              </div>
            )}
            <div>
              <div className="mb-1 flex items-center justify-between"><span className="text-xs font-medium text-muted">What changed (optional)</span>
                <Button variant="ghost" size="sm" onClick={() => setChanges([...changes, { label: '', from: '', to: '' }])}><Plus size={13} />Add change</Button></div>
              {changes.map((c, i) => (
                <div key={i} className="mb-2 grid grid-cols-[1fr_1fr_1fr_auto] gap-2">
                  {(['label', 'from', 'to'] as const).map((k) => <input key={k} aria-label={k} className={inputCls} placeholder={k === 'label' ? 'Time' : k === 'from' ? 'Previous' : 'Updated'} value={c[k]} onChange={(e) => setChanges(changes.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))} />)}
                  <button aria-label="Remove change" className="px-1 text-muted hover:text-fail" onClick={() => setChanges(changes.filter((_, j) => j !== i))}><X size={15} /></button>
                </div>
              ))}
            </div>
            <Field label="Priority" hint={isCritical ? 'Critical: delivered immediately, ignores mutes and Focus Mode. Use only for safety, closures and cancellations.' : 'High and normal respect student preferences and Focus Mode.'} htmlFor="cp">
              <select id="cp" className={inputCls} value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="">Workflow default ({wf?.priority ?? 'normal'})</option>
                <option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="critical">Critical</option>
              </select>
            </Field>
          </section>

          <section>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">3 · Audience</h2>
            <label className="mb-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />Entire university</label>
            {!everyone && (
              <>
                <div className="mb-2 flex flex-wrap gap-1">
                  {KIND_ORDER.filter((k) => groups.data?.groups.some((g) => g.kind === k)).map((k) => (
                    <button key={k} onClick={() => setPickerKind(k)} className={cx('rounded-md px-2.5 py-1 text-xs', pickerKind === k ? 'bg-ink text-paper' : 'text-muted hover:bg-sunken')}>{KIND_LABEL[k]}</button>
                  ))}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {groups.data?.groups.filter((g) => g.kind === pickerKind).map((g) => {
                    const on = audience.includes(g.key);
                    return (
                      <button key={g.key} onClick={() => setAudience(on ? audience.filter((a) => a !== g.key) : [...audience, g.key])}
                        className={cx('rounded-md border px-2.5 py-1 text-xs transition-colors', on ? 'border-primary bg-primary text-primary-ink' : 'border-line bg-surface hover:border-ink/30')}>
                        {g.name} <span className={on ? 'opacity-80' : 'text-muted'}>{g.members}</span>
                      </button>
                    );
                  })}
                </div>
                {audience.length > 0 && <p className="mt-3 text-xs text-muted">Students in any of: {audience.map(groupName).join(', ')}</p>}
              </>
            )}
          </section>
        </div>

        <aside className="space-y-4 xl:sticky xl:top-20 xl:self-start">
          <div className="rounded-xl border border-line bg-surface p-5">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted"><Users size={13} />Audience</p>
            <p className="mt-1 text-3xl font-semibold tabular-nums">{estimate == null ? '—' : estimate.toLocaleString()}<span className="ml-1 text-base font-normal text-muted">students</span></p>
            <dl className="mt-4 space-y-1.5 text-sm">
              <div className="flex justify-between"><dt className="text-muted">Channels</dt><dd className="flex items-center gap-2">{channels.includes('in-app') && <span className="flex items-center gap-1"><InboxIcon size={13} />In-app</span>}{channels.includes('email') && <span className="flex items-center gap-1"><Mail size={13} />Email</span>}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Timing</dt><dd>{digest ? <span className="flex items-center gap-1"><Layers size={13} />Combine for {Math.round((digest.windowMs ?? 0) / 60000)} min</span> : 'Immediately'}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Priority</dt><dd className={cx(isCritical && 'font-medium text-accent')}>{isCritical ? 'Critical' : effPriority[0].toUpperCase() + effPriority.slice(1)}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Focus Mode</dt><dd>{isCritical ? 'Bypasses' : 'Held until focus ends'}</dd></div>
            </dl>
            <ErrorNote error={error} />
            <Button className="mt-5 w-full" disabled={!canSend} onClick={publish}>{busy ? 'Publishing…' : `Publish${estimate ? ` to ${estimate.toLocaleString()}` : ''}`}</Button>
          </div>

          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Student preview</p>
            <div className={cx('relative rounded-lg border bg-surface p-4', isCritical ? 'border-accent/50' : 'border-line')}>
              {isCritical && <span className="absolute inset-y-3 left-0 w-0.5 rounded bg-accent" />}
              <div className="flex items-center gap-2 text-[11px] text-muted">
                {isCritical && <span className="font-semibold uppercase text-accent">Critical</span>}
                {effPriority === 'high' && !isCritical && <span className="font-medium uppercase text-warn">High</span>}
                <span>{CAT_LABEL[wf?.category ?? ''] ?? ''}</span><span>·</span><span>{wf?.name}</span><span className="ml-auto">now</span>
              </div>
              <p className="mt-1.5 font-semibold">{title || 'Your title appears here'}</p>
              {changes.filter((c) => c.label && c.to).length > 0 && (
                <table className="mt-2 w-full text-xs"><tbody>{changes.filter((c) => c.label && c.to).map((c, i) => (
                  <tr key={i} className="border-t border-line"><td className="py-1 text-muted">{c.label}</td><td className="py-1 text-muted line-through">{c.from}</td><td className="py-1 font-semibold">{c.to}</td></tr>
                ))}</tbody></table>
              )}
              <p className="mt-2 text-sm text-muted">{summary || 'Your summary appears here.'}</p>
              {wf?.primaryAction && (
                <div className="mt-3 flex gap-2">
                  <span className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-ink">{fill(wf.primaryAction.label, fields)}</span>
                  {wf.secondaryAction && <span className="rounded-md border border-line px-3 py-1.5 text-xs">{fill(wf.secondaryAction.label, fields)}</span>}
                </div>
              )}
            </div>
            {channels.includes('email') && <p className="mt-2 text-xs text-muted">Email subject: “{title || '…'}”, sent to students who keep email on for {CAT_LABEL[wf?.category ?? '']?.toLowerCase()}.</p>}
          </div>
        </aside>
      </div>
    </div>
  );
}
