import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, Bell, BookOpen, Building2, CalendarDays, Check, CheckCheck, ChevronLeft, CircleUser, Clock, Focus as FocusIcon,
  GraduationCap, Inbox as InboxIcon, Layers, LayoutDashboard, Mail, Search, Settings2, Shapes, Users,
} from 'lucide-react';
import { session, startStudentSession, student, type FocusStatus, type FocusSummary, type Prefs } from '../../api';
import { Logo, Shell, ThemeToggle } from '../../components/Shell';
import { Button, ErrorNote, Field, Spinner, Switch, cx, fmtDateTime, inputCls, useLoad, useToast } from '../../components/ui';
import { useLiveNotifications } from '../../realtime';
import { Skyline } from '../../components/Skyline';


// ------------------------------------------------------------------ shared types + helpers

interface Action { label: string; url: string | null }
interface Change { label: string; from: string; to: string }
export interface FeedItem {
  messageId: string; notificationId: string; title: string; content: string; category: string; priority: 'critical' | 'high' | 'normal' | 'low';
  source: string; workflowId: string; seen: boolean; archived: boolean; createdAt: string; readAt: string | null; clickedAt: string | null;
  updates: number; payload: Record<string, unknown> & { changes?: Change[]; summary?: string; eventDate?: string; examDate?: string; courseName?: string };
  primaryAction: Action | null; secondaryAction: Action | null;
}
interface Detail extends FeedItem {
  reason: string; digest: { at: string; payload: FeedItem['payload'] }[]; related: FeedItem[];
  delivery: { inApp: string; email: string; emailSentAt: string | null };
}
interface Feed { items: FeedItem[]; counts: { total: number; unread: number; criticalUnread: number; unreadByCategory: Record<string, number> } }

export const CATEGORIES: { key: string; label: string; icon: ReactNode; blurb: string }[] = [
  { key: 'academic', label: 'Academic', icon: <GraduationCap size={16} />, blurb: 'Exams, classes, assignments and grades' },
  { key: 'campus', label: 'Campus', icon: <Building2 size={16} />, blurb: 'Closures, transport, facilities and safety' },
  { key: 'events', label: 'Events', icon: <CalendarDays size={16} />, blurb: 'University events, talks and workshops' },
  { key: 'administrative', label: 'Administrative', icon: <BookOpen size={16} />, blurb: 'Fees, documents and official announcements' },
  { key: 'clubs', label: 'Clubs & Activities', icon: <Users size={16} />, blurb: 'Clubs, teams and societies you follow' },
];
export const catLabel = (k: string) => CATEGORIES.find((c) => c.key === k)?.label ?? k;

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

export function PriorityTag({ p }: { p: FeedItem['priority'] }) {
  if (p === 'critical') return <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent ring-1 ring-accent/40"><AlertTriangle size={11} />Critical</span>;
  if (p === 'high') return <span className="rounded px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-warn ring-1 ring-warn/30">High</span>;
  return null;
}

/** Merge the "changes" of every update in a digest: earliest "from", latest "to" per field. */
function mergedChanges(entries: FeedItem['payload'][]): Change[] {
  const map = new Map<string, Change>();
  for (const p of entries) for (const c of p.changes ?? []) {
    const cur = map.get(c.label);
    map.set(c.label, cur ? { ...cur, to: c.to } : { ...c });
  }
  return [...map.values()];
}

function useStudent() {
  const [, force] = useState(0);
  useEffect(() => session.subscribe(() => force((n) => n + 1)), []);
  return session.studentToken ? session.studentId : null;
}

// ------------------------------------------------------------------ app + shell

export function StudentApp() {
  const me = useStudent();
  if (!me) return <StudentLogin />;
  return <StudentShell me={me} />;
}

function StudentLogin() {
  const [id, setId] = useState('student_001');
  const [key, setKey] = useState(session.adminKey ?? '');
  const [needKey, setNeedKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (key) session.setAdminKey(key);
      await startStudentSession(id.trim());
    } catch (err) {
      if ((err as { status?: number }).status === 401) { setNeedKey(true); setError('This server needs the campus access key to sign students in.'); }
      else setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };
  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden px-4">
      <Skyline className="pointer-events-none absolute inset-x-0 bottom-0 h-56 w-full text-primary/20" />
      <div className="relative w-full max-w-sm rounded-2xl border border-line bg-surface/90 p-8 shadow-[0_1px_2px_rgba(20,33,61,.05),0_12px_32px_-12px_rgba(20,33,61,.18)] backdrop-blur">
        <div className="mb-8 flex items-center justify-between"><Logo sub="SRM University" /><ThemeToggle /></div>
        <h1 className="text-xl font-semibold">Sign in to your notifications</h1>
        <p className="mt-1 text-sm text-muted">Use your university ID.</p>
        <form onSubmit={submit} className="mt-6 space-y-4">
          <Field label="University ID" htmlFor="sid"><input id="sid" className={inputCls} value={id} onChange={(e) => setId(e.target.value)} autoComplete="username" required /></Field>
          {needKey && <Field label="Campus access key" htmlFor="skey"><input id="skey" type="password" className={inputCls} value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" /></Field>}
          <ErrorNote error={error} />
          <Button type="submit" disabled={busy || !id.trim()} className="w-full">{busy ? 'Signing in…' : 'Continue'}</Button>
        </form>
        <p className="mt-6 text-xs text-muted">Sign-in is normally handled by university single sign-on.</p>
      </div>
    </div>
  );
}

function StudentShell({ me }: { me: string }) {
  const toast = useToast();
  const [tick, setTick] = useState(0);
  const counts = useLoad(() => student.get<Feed>('/inbox/feed?limit=1'), [tick], 15000);
  const focus = useLoad(() => student.get<FocusStatus>('/inbox/focus-mode/status'), [tick], 10000);
  const live = useLiveNotifications((n) => { toast('info', n.subject || 'New notification'); setTick((t) => t + 1); });
  const c = counts.data?.counts;
  return (
    <Shell
      sub="SRM University"
      nav={[
        { to: '/app', label: 'Overview', end: true, icon: <LayoutDashboard size={16} /> },
        { to: '/app/inbox', label: 'Inbox', icon: <InboxIcon size={16} />, badge: c?.unread ? <span className="rounded bg-primary px-1.5 text-[11px] font-semibold text-primary-ink">{c.unread}</span> : undefined },
        { to: '/app/focus', label: 'Focus Mode', icon: <FocusIcon size={16} />, badge: focus.data?.active ? <span className="h-2 w-2 rounded-full bg-accent" aria-label="active" /> : undefined },
        { to: '/app/topics', label: 'Topics', icon: <Shapes size={16} /> },
        { to: '/app/preferences', label: 'Preferences', icon: <Settings2 size={16} /> },
        { to: '/app/profile', label: 'Profile', icon: <CircleUser size={16} /> },
      ]}
      right={(
        <>
          <span className="hidden items-center gap-1.5 text-xs text-muted sm:flex">
            <span className={cx('h-1.5 w-1.5 rounded-full', live === 'live' ? 'bg-ok' : live === 'connecting' ? 'bg-warn' : 'bg-fail')} />
            {live === 'live' ? 'Live' : live === 'connecting' ? 'Connecting' : 'Offline'}
          </span>
          <span className="text-sm text-muted">{me}</span>
          <Button variant="secondary" size="sm" onClick={() => session.setStudent(null, null)}>Sign out</Button>
        </>
      )}
    >
      {focus.data?.active && focus.data.session && (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-accent/30 bg-accent-soft px-4 py-2.5 text-sm text-accent">
          <FocusIcon size={16} /><span><strong>You're focused</strong> until {new Date(focus.data.session.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Non-critical updates are being held ({focus.data.heldCount}).</span>
          <Link to="/app/focus" className="ml-auto font-medium underline">Manage</Link>
        </div>
      )}
      <Routes>
        <Route index element={<Overview tick={tick} />} />
        <Route path="inbox" element={<Inbox tick={tick} onChange={() => setTick((t) => t + 1)} />} />
        <Route path="inbox/:id" element={<Inbox tick={tick} onChange={() => setTick((t) => t + 1)} />} />
        <Route path="focus" element={<Focus />} />
        <Route path="topics" element={<Topics />} />
        <Route path="preferences" element={<Preferences />} />
        <Route path="profile" element={<Profile />} />
        <Route path="*" element={<Navigate to="/app" replace />} />
      </Routes>
    </Shell>
  );
}

// ------------------------------------------------------------------ overview

function Overview({ tick }: { tick: number }) {
  const feed = useLoad(() => student.get<Feed>('/inbox/feed?limit=200'), [tick]);
  const profile = useLoad(() => student.get<{ firstName: string | null }>('/inbox/profile'), []);
  const focus = useLoad(() => student.get<FocusSummary | null>('/inbox/focus-mode/summary').catch(() => null), [tick]);
  if (!feed.data) return <><ErrorNote error={feed.error} />{!feed.error && <Spinner />}</>;
  const items = feed.data.items;
  const critical = items.filter((i) => i.priority === 'critical' && !i.seen);
  const rank = (i: FeedItem) => (i.priority === 'high' ? 0 : 1);
  const attention = items.filter((i) => !i.seen && i.priority !== 'critical').sort((a, b) => rank(a) - rank(b)).slice(0, 5);
  const upcoming = items
    .map((i) => ({ i, when: (i.payload.eventDate || i.payload.examDate) as string | undefined }))
    .filter((x) => x.when && new Date(x.when).getTime() > Date.now())
    .sort((a, b) => new Date(a.when!).getTime() - new Date(b.when!).getTime()).slice(0, 4);
  const digests = items.filter((i) => i.updates > 1).slice(0, 3);
  const hour = new Date().getHours();
  return (
    <div className="space-y-8">
      <header>
        <p className="text-sm text-muted">{new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Good {hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}{profile.data?.firstName ? `, ${profile.data.firstName}` : ''}</h1>
        <p className="mt-1 text-sm text-muted">
          {feed.data.counts.unread === 0 ? 'You are all caught up.' : `${feed.data.counts.unread} unread, ${critical.length ? `${critical.length} critical` : 'nothing critical'}.`}
        </p>
      </header>

      {critical.length > 0 && (
        <section aria-label="Critical alerts" className="space-y-2">
          {critical.map((c) => (
            <Link key={c.messageId} to={`/app/inbox/${c.messageId}`} className="flex items-start gap-3 rounded-lg border border-accent/40 bg-accent-soft/60 p-4 transition-colors hover:bg-accent-soft">
              <AlertTriangle className="mt-0.5 shrink-0 text-accent" size={18} />
              <div className="min-w-0">
                <p className="font-semibold text-ink">{c.title}</p>
                <p className="mt-0.5 text-sm text-muted">{c.content}</p>
                <p className="mt-1 text-xs text-accent">Critical · {c.source} · {ago(c.createdAt)} · open to acknowledge</p>
              </div>
            </Link>
          ))}
        </section>
      )}

      <div className="grid gap-x-10 gap-y-8 lg:grid-cols-[1.4fr_1fr]">
        <section>
          <SectionHead title="Needs your attention" link={{ to: '/app/inbox', label: 'Open inbox' }} />
          {attention.length === 0 ? <p className="py-6 text-sm text-muted">Nothing waiting. Important campus updates will appear here.</p> : (
            <ul className="divide-y divide-line border-y border-line">{attention.map((i) => <Row key={i.messageId} item={i} />)}</ul>
          )}
          {digests.length > 0 && (
            <>
              <SectionHead title="Combined updates" className="mt-8" />
              <ul className="space-y-2">
                {digests.map((d) => {
                  const changes = mergedChanges([d.payload]);
                  return (
                    <li key={d.messageId}>
                      <Link to={`/app/inbox/${d.messageId}`} className="block rounded-lg border border-line bg-surface p-4 transition-colors hover:border-primary/40">
                        <div className="flex items-center gap-2 text-xs text-muted"><Layers size={13} />{d.updates} related updates combined · {catLabel(d.category)}</div>
                        <p className="mt-1 font-medium">{(d.payload.courseName as string) || d.title.replace(/^\d+ updates: /, '')}</p>
                        <p className="text-sm text-muted">{changes.length ? changes.map((c) => c.to).join(' · ') : d.payload.summary}</p>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </section>
        <aside className="space-y-8">
          <section>
            <SectionHead title="Coming up" />
            {upcoming.length === 0 ? <p className="text-sm text-muted">No upcoming dates from your notifications.</p> : (
              <ul className="space-y-3">
                {upcoming.map(({ i, when }) => (
                  <li key={i.messageId} className="flex gap-3">
                    <div className="w-12 shrink-0 rounded-md border border-line bg-surface py-1 text-center">
                      <p className="text-[10px] font-medium uppercase text-accent">{new Date(when!).toLocaleDateString(undefined, { month: 'short' })}</p>
                      <p className="text-lg font-semibold leading-tight">{new Date(when!).getDate()}</p>
                    </div>
                    <Link to={`/app/inbox/${i.messageId}`} className="min-w-0 hover:underline">
                      <p className="truncate text-sm font-medium">{(i.payload.courseName as string) || i.title.replace(/^\d+ updates: /, '')}</p>
                      <p className="text-xs text-muted">{new Date(when!).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })} · {i.source}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <SectionHead title="Last focus session" link={{ to: '/app/focus', label: 'Focus Mode' }} />
            {focus.data && focus.data.heldCount > 0 ? (
              <p className="text-sm text-muted">{focus.data.items.length} change{focus.data.items.length === 1 ? '' : 's'} summarised from {focus.data.heldCount} held update{focus.data.heldCount === 1 ? '' : 's'}; {focus.data.suppressed.acknowledged + focus.data.suppressed.duplicates} redundant left out.</p>
            ) : <p className="text-sm text-muted">Hold non-critical updates while you study. You get one summary when you're done.</p>}
          </section>
          <section>
            <SectionHead title="Unread by category" />
            <ul className="space-y-1 text-sm">
              {CATEGORIES.map((c) => (
                <li key={c.key}>
                  <Link to={`/app/inbox?category=${c.key}`} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-sunken">
                    <span className="text-muted">{c.icon}</span>{c.label}<span className="ml-auto tabular-nums text-muted">{feed.data!.counts.unreadByCategory[c.key] ?? 0}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>
    </div>
  );
}

function SectionHead({ title, link, className }: { title: string; link?: { to: string; label: string }; className?: string }) {
  return (
    <div className={cx('mb-3 flex items-baseline justify-between', className)}>
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">{title}</h2>
      {link && <Link to={link.to} className="text-xs font-medium text-primary hover:underline">{link.label}</Link>}
    </div>
  );
}

function Row({ item, active, onClick }: { item: FeedItem; active?: boolean; onClick?: () => void }) {
  const body = (
    <div className={cx('relative flex gap-3 px-4 py-3 transition-colors', active ? 'bg-primary-soft/70' : 'hover:bg-sunken/70',
      item.priority === 'critical' && 'before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded before:bg-accent')}>
      <span className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full transition-colors', item.seen ? 'bg-transparent' : item.priority === 'critical' ? 'bg-accent' : 'bg-primary')} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className={cx('truncate text-sm', item.seen ? 'text-ink/80' : 'font-semibold')}>{item.updates > 1 ? ((item.payload.courseName as string) ?? item.title) : item.title}</p>
          <span className="ml-auto shrink-0 text-xs text-muted">{ago(item.createdAt)}</span>
        </div>
        <p className="mt-0.5 line-clamp-1 text-sm text-muted">{item.updates > 1 ? `${item.updates} related updates · ${mergedChanges([item.payload]).map((c) => c.to).join(' · ') || item.payload.summary}` : item.content}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-muted">
          <PriorityTag p={item.priority} />
          <span>{catLabel(item.category)}</span><span aria-hidden>·</span><span>{item.source}</span>
          {item.updates > 1 && <span className="inline-flex items-center gap-1 text-primary"><Layers size={11} />Combined</span>}
          {!item.seen && <span className="sr-only">unread</span>}
        </div>
      </div>
    </div>
  );
  if (onClick) return <li><button type="button" onClick={onClick} className="block w-full text-left">{body}</button></li>;
  return <li><Link to={`/app/inbox/${item.messageId}`}>{body}</Link></li>;
}

// ------------------------------------------------------------------ inbox

function Inbox({ tick, onChange }: { tick: number; onChange: () => void }) {
  const toast = useToast();
  const nav = useNavigate();
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const category = params.get('category') || '';
  const view = params.get('view') || 'all';
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('newest');
  const query = new URLSearchParams({ limit: '200', sort, ...(category ? { category } : {}), ...(q ? { q } : {}),
    ...(view === 'unread' ? { seen: 'false' } : {}), ...(view === 'critical' ? { priority: 'critical' } : {}), ...(view === 'archived' ? { archived: 'true' } : {}) }).toString();
  const feed = useLoad(() => student.get<Feed>(`/inbox/feed?${query}`), [query, tick]);
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p); };
  const readAll = async () => {
    const r = await student.post<{ updated: number }>('/inbox/read-all', category ? { category } : {});
    toast('ok', r.updated ? `Marked ${r.updated} as read` : 'Nothing unread');
    feed.reload(); onChange();
  };
  const tabs = [['all', 'All'], ['unread', 'Unread'], ['critical', 'Critical'], ['archived', 'Archived']];
  return (
    <div className="-mx-4 -my-8 sm:-mx-6 lg:grid lg:h-[calc(100vh-57px)] lg:grid-cols-[minmax(320px,420px)_1fr]">
      <section className={cx('flex min-h-0 flex-col border-line lg:border-r', id && 'hidden lg:flex')}>
        <div className="space-y-3 border-b border-line px-4 pb-3 pt-6">
          <div className="flex items-center justify-between">
            <h1 className="text-lg font-semibold">Inbox</h1>
            <Button variant="ghost" size="sm" onClick={readAll}><CheckCheck size={14} />Mark all read</Button>
          </div>
          <div className="relative">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
            <input aria-label="Search notifications" className={cx(inputCls, 'pl-9')} placeholder="Search notifications" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="flex gap-1 overflow-x-auto" role="tablist">
            {tabs.map(([k, l]) => (
              <button key={k} role="tab" aria-selected={view === k} onClick={() => set('view', k === 'all' ? '' : k)}
                className={cx('whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors', view === k ? 'bg-ink text-paper' : 'text-muted hover:bg-sunken')}>
                {l}{k === 'unread' && feed.data?.counts.unread ? ` ${feed.data.counts.unread}` : ''}{k === 'critical' && feed.data?.counts.criticalUnread ? ` ${feed.data.counts.criticalUnread}` : ''}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <select aria-label="Category" className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-xs" value={category} onChange={(e) => set('category', e.target.value)}>
              <option value="">All categories</option>
              {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}{feed.data?.counts.unreadByCategory[c.key] ? ` (${feed.data.counts.unreadByCategory[c.key]})` : ''}</option>)}
            </select>
            <select aria-label="Sort" className="rounded-md border border-line bg-surface px-2 py-1 text-xs" value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="newest">Newest</option><option value="oldest">Oldest</option><option value="priority">Priority</option>
            </select>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ErrorNote error={feed.error} />
          {!feed.data ? <div className="p-6"><Spinner /></div> : feed.data.items.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <p className="font-medium">{q ? 'No matches' : view === 'archived' ? 'Nothing archived' : "You're all caught up."}</p>
              <p className="mt-1 text-sm text-muted">{q ? 'Try a different search.' : 'Important campus updates will appear here.'}</p>
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {feed.data.items.map((i) => <Row key={i.messageId} item={i} active={i.messageId === id} onClick={() => nav(`/app/inbox/${i.messageId}?${params.toString()}`)} />)}
            </ul>
          )}
        </div>
      </section>
      <section className={cx('min-h-0 overflow-y-auto', !id && 'hidden lg:block')}>
        {id ? <NotificationDetail key={id} id={id} onChange={() => { feed.reload(); onChange(); }} onBack={() => nav(`/app/inbox?${params.toString()}`)} />
          : <div className="grid h-full place-items-center px-6 text-center text-sm text-muted"><div><Bell className="mx-auto mb-3 text-line" size={28} />Select a notification to read it.</div></div>}
      </section>
    </div>
  );
}

function NotificationDetail({ id, onChange, onBack }: { id: string; onChange: () => void; onBack: () => void }) {
  const toast = useToast();
  const d = useLoad(() => student.get<Detail>(`/inbox/feed/${id}`), [id]);
  useEffect(() => {
    if (d.data && !d.data.seen) student.post(`/inbox/feed/${id}/read`).then(onChange).catch(() => {});
  }, [d.data?.messageId]); // mark read once, when opened
  if (!d.data) return <div className="p-8"><ErrorNote error={d.error} />{!d.error && <Spinner />}</div>;
  const n = d.data;
  const entries = n.digest.length ? n.digest.map((x) => x.payload) : [n.payload];
  const changes = mergedChanges(entries);
  const latest = entries[entries.length - 1];
  const act = async (a: Action) => {
    await student.post(`/inbox/feed/${id}/click`);
    toast('ok', `${a.label}: opening ${a.url ?? 'the university portal'}`);
    d.reload(); onChange();
  };
  const toggleRead = async () => { await student.post(`/inbox/feed/${id}/read`, { read: !n.seen }); toast('ok', n.seen ? 'Marked as unread' : 'Marked as read'); d.reload(); onChange(); };
  const archive = async () => { await student.patch(`/inbox/notifications/${id}/archived`, { archived: !n.archived }); toast('ok', n.archived ? 'Moved back to inbox' : 'Archived'); d.reload(); onChange(); };
  const heading = n.updates > 1 && n.payload.courseName ? `${n.payload.courseName as string}: ${n.updates} updates` : n.title;
  return (
    <article className="cne-fade mx-auto max-w-2xl px-5 py-6 sm:px-8 sm:py-8">
      <button onClick={onBack} className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-ink lg:hidden"><ChevronLeft size={16} />Inbox</button>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <PriorityTag p={n.priority} /><span>{catLabel(n.category)}</span><span>·</span><span>{n.source}</span><span>·</span><time dateTime={n.createdAt}>{fmtDateTime(n.createdAt)}</time>
      </div>
      <h1 className="mt-2 text-2xl font-semibold leading-snug tracking-tight">{heading}</h1>
      {n.priority === 'critical' && (
        <p className="mt-3 flex items-start gap-2 rounded-md bg-accent-soft px-3 py-2 text-sm text-accent"><AlertTriangle size={16} className="mt-0.5 shrink-0" />Critical notice. Delivered immediately, even if you muted this category or are in Focus Mode.</p>
      )}
      {n.updates > 1 && <p className="mt-3 flex items-center gap-2 text-sm text-primary"><Layers size={15} />{n.updates} related updates were combined into this one notification.</p>}

      {changes.length > 0 && (
        <div className="mt-6 overflow-hidden rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="bg-sunken text-left text-xs text-muted"><tr><th className="px-4 py-2 font-medium">What changed</th><th className="px-4 py-2 font-medium">Previous</th><th className="px-4 py-2 font-medium">Updated</th></tr></thead>
            <tbody>{changes.map((c) => (
              <tr key={c.label} className="border-t border-line"><td className="px-4 py-2.5 text-muted">{c.label}</td><td className="px-4 py-2.5 text-muted line-through decoration-muted/50">{c.from}</td><td className="px-4 py-2.5 font-semibold">{c.to}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <p className="mt-6 text-[15px] leading-relaxed">{(latest.summary as string) || n.content}</p>

      {(n.primaryAction || n.secondaryAction) && (
        <div className="mt-6 flex flex-wrap items-center gap-2">
          {n.primaryAction && <Button onClick={() => act(n.primaryAction!)}>{n.primaryAction.label}</Button>}
          {n.secondaryAction && <Button variant="secondary" onClick={() => act(n.secondaryAction!)}>{n.secondaryAction.label}</Button>}
          {n.clickedAt && <span className="text-xs text-muted"><Check size={12} className="mr-1 inline" />Opened {ago(n.clickedAt)}</span>}
        </div>
      )}

      {n.digest.length > 1 && (
        <section className="mt-8">
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">Updates in order</h2>
          <ol className="relative space-y-4 border-l border-line pl-5">
            {n.digest.map((u, i) => (
              <li key={i} className="relative">
                <span className="absolute -left-[25px] top-1.5 h-2 w-2 rounded-full bg-primary ring-4 ring-paper" />
                <p className="text-sm font-medium">{(u.payload.title as string) ?? `Update ${i + 1}`}</p>
                <p className="text-sm text-muted">{u.payload.summary as string}</p>
                <p className="mt-0.5 text-xs text-muted">{new Date(u.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="mt-8 grid gap-4 border-t border-line pt-6 text-sm sm:grid-cols-2">
        <div>
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Why you received this</h2>
          <p className="text-muted">{n.reason}</p>
        </div>
        <div>
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Delivery</h2>
          <p className="flex items-center gap-1.5 text-muted"><InboxIcon size={13} />In-app: {n.delivery.inApp}</p>
          <p className="flex items-center gap-1.5 text-muted"><Mail size={13} />Email: {n.delivery.email === 'pending' && !n.delivery.emailSentAt ? 'not used for this notice' : n.delivery.email}</p>
        </div>
      </section>

      {n.related.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Related</h2>
          <ul className="divide-y divide-line rounded-lg border border-line">{n.related.map((r) => <Row key={r.messageId} item={r} />)}</ul>
        </section>
      )}

      <div className="mt-8 flex gap-2 border-t border-line pt-4">
        <Button variant="ghost" size="sm" onClick={toggleRead}>{n.seen ? 'Mark as unread' : 'Mark as read'}</Button>
        <Button variant="ghost" size="sm" onClick={archive}>{n.archived ? 'Move to inbox' : 'Archive'}</Button>
      </div>
    </article>
  );
}

// ------------------------------------------------------------------ preferences

function Preferences() {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => student.get<Prefs & { categories: Record<string, { email?: boolean; inApp?: boolean }> }>('/inbox/preferences'), []);
  const save = async (path: string, patch: Record<string, boolean>) => {
    try { await student.patch(path, patch); toast('ok', 'Saved. Applies to everything not yet delivered.'); reload(); } catch (e) { toast('fail', (e as Error).message); }
  };
  if (!data) return <><ErrorNote error={error} />{!error && <Spinner />}</>;
  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Preferences</h1>
      <p className="mt-1 text-sm text-muted">Choose how each kind of update reaches you. Critical safety and closure notices always reach you.</p>

      <section className="mt-8">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">Defaults</h2>
        <div className="mt-2 divide-y divide-line border-y border-line">
          {([['inApp', 'In-app', 'Your inbox in this portal'], ['email', 'Email', 'Your university email address']] as const).map(([k, label, hint]) => (
            <div key={k} className="flex items-center justify-between py-3">
              <div><p className="text-sm font-medium">{label}</p><p className="text-xs text-muted">{hint}</p></div>
              <Switch label={`${label} by default`} checked={data.global[k]} onChange={(v) => save('/inbox/preferences', { [k]: v })} />
            </div>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">By category</h2>
        <div className="mt-2 overflow-hidden rounded-lg border border-line">
          <div className="hidden grid-cols-[1fr_90px_90px] bg-sunken px-4 py-2 text-xs text-muted sm:grid"><span>Category</span><span className="text-center">In-app</span><span className="text-center">Email</span></div>
          {CATEGORIES.map((c) => {
            const o = data.categories[c.key] ?? {};
            return (
              <div key={c.key} className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-t border-line px-4 py-3 sm:grid-cols-[1fr_90px_90px]">
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 text-muted">{c.icon}</span>
                  <div><p className="text-sm font-medium">{c.label}</p><p className="text-xs text-muted">{c.blurb}</p></div>
                </div>
                {(['inApp', 'email'] as const).map((k) => {
                  const inherited = o[k] === undefined;
                  const value = inherited ? data.global[k] : !!o[k];
                  return (
                    <div key={k} className="flex flex-col items-center gap-0.5">
                      <Switch label={`${c.label} ${k === 'inApp' ? 'in-app' : 'email'}`} checked={value} onChange={(v) => save(`/inbox/preferences/categories/${c.key}`, { [k]: v })} />
                      <span className="text-[10px] text-muted">{inherited ? 'default' : 'custom'}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        <p className="mt-3 flex items-start gap-2 text-xs text-muted"><AlertTriangle size={13} className="mt-0.5 shrink-0 text-accent" />Campus closures, security alerts and other critical notices ignore these settings. They are rare and reserved for your safety.</p>
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ topics

interface Topic { key: string; name: string; description: string | null; kind: string; followable: boolean; members: number; following: boolean }
const KIND_LABEL: Record<string, string> = { club: 'Clubs & teams', service: 'Campus services', interest: 'Interests', course: 'Courses', department: 'Department', year: 'Year', residence: 'Residence' };

function Topics() {
  const toast = useToast();
  const { data, error, reload } = useLoad(() => student.get<{ topics: Topic[] }>('/inbox/topics'), []);
  const [open, setOpen] = useState<string | null>(null);
  const detail = useLoad(() => (open ? student.get<Topic & { generates: string[]; recent: { at: string; workflow: string; title: string | null }[] }>(`/inbox/topics/${encodeURIComponent(open)}`) : Promise.resolve(null)), [open]);
  const toggle = async (t: Topic) => {
    try {
      const res = await fetch(`/inbox/topics/${encodeURIComponent(t.key)}/follow`, { method: t.following ? 'DELETE' : 'POST', headers: { authorization: `Bearer ${session.studentToken}` } });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `HTTP ${res.status}`);
      toast('ok', t.following ? `Unfollowed ${t.name}` : `Following ${t.name}`);
      reload(); detail.reload();
    } catch (e) { toast('fail', (e as Error).message); }
  };
  const groups = useMemo(() => {
    const g = new Map<string, Topic[]>();
    for (const t of data?.topics ?? []) {
      if (!t.followable && !t.following) continue;
      const k = t.followable ? t.kind : 'assigned';
      g.set(k, [...(g.get(k) ?? []), t]);
    }
    return [...g.entries()].sort((a, b) => Number(a[0] === 'assigned') - Number(b[0] === 'assigned'));
  }, [data]);
  if (!data) return <><ErrorNote error={error} />{!error && <Spinner />}</>;
  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_340px]">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Topics</h1>
        <p className="mt-1 text-sm text-muted">Follow the clubs and services you care about. Course, department and residence groups come from your enrolment.</p>
        {groups.map(([kind, list]) => (
          <section key={kind} className="mt-8">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">{kind === 'assigned' ? 'Assigned by the university' : KIND_LABEL[kind] ?? kind}</h2>
            <ul className="mt-2 divide-y divide-line border-y border-line">
              {list.map((t) => (
                <li key={t.key} className={cx('flex items-center gap-3 px-2 py-3 transition-colors', open === t.key && 'bg-sunken/70')}>
                  <button className="min-w-0 flex-1 text-left" onClick={() => setOpen(t.key)}>
                    <p className="text-sm font-medium">{t.name}</p>
                    <p className="truncate text-xs text-muted">{t.description} · {t.members} members</p>
                  </button>
                  {t.followable ? (
                    <Button size="sm" variant={t.following ? 'secondary' : 'primary'} onClick={() => toggle(t)}>{t.following ? 'Following' : 'Follow'}</Button>
                  ) : <span className="text-xs text-muted">Assigned</span>}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <aside className="lg:sticky lg:top-6 lg:self-start">
        {!detail.data ? <p className="rounded-lg border border-dashed border-line p-6 text-sm text-muted">Select a topic to see what it sends you.</p> : (
          <div className="cne-fade rounded-lg border border-line bg-surface p-5">
            <p className="text-xs uppercase tracking-wider text-muted">{KIND_LABEL[detail.data.kind] ?? detail.data.kind}</p>
            <h2 className="mt-1 text-lg font-semibold">{detail.data.name}</h2>
            <p className="mt-1 text-sm text-muted">{detail.data.description}</p>
            <p className="mt-3 text-sm">{detail.data.following ? 'You receive updates from this topic.' : 'You are not following this topic.'}</p>
            <h3 className="mt-5 text-xs font-semibold uppercase tracking-wider text-muted">Sends</h3>
            <p className="mt-1 text-sm">{detail.data.generates.length ? detail.data.generates.join(', ') : 'Nothing sent yet.'}</p>
            <h3 className="mt-5 text-xs font-semibold uppercase tracking-wider text-muted">Recent</h3>
            <ul className="mt-1 space-y-2 text-sm">
              {detail.data.recent.length === 0 && <li className="text-muted">Nothing recent.</li>}
              {detail.data.recent.map((r, i) => <li key={i}><p>{r.title ?? r.workflow}</p><p className="text-xs text-muted">{fmtDateTime(r.at)}</p></li>)}
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}

// ------------------------------------------------------------------ profile

function Profile() {
  const p = useLoad(() => student.get<{ subscriberId: string; email: string; firstName: string | null; lastName: string | null; department: string | null; year: number | null; program: string | null; topics: { key: string; name: string }[] }>('/inbox/profile'), []);
  if (!p.data) return <><ErrorNote error={p.error} />{!p.error && <Spinner />}</>;
  const s = p.data;
  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
      <dl className="mt-6 grid grid-cols-[140px_1fr] gap-y-3 border-y border-line py-4 text-sm">
        <dt className="text-muted">Name</dt><dd>{[s.firstName, s.lastName].filter(Boolean).join(' ') || '—'}</dd>
        <dt className="text-muted">University ID</dt><dd className="font-mono text-xs">{s.subscriberId}</dd>
        <dt className="text-muted">Email</dt><dd>{s.email}</dd>
        <dt className="text-muted">Programme</dt><dd>{s.program ?? '—'}{s.department ? ` · ${s.department}` : ''}{s.year ? ` · Year ${s.year}` : ''}</dd>
      </dl>
      <h2 className="mt-8 text-xs font-semibold uppercase tracking-wider text-muted">Groups and topics</h2>
      <div className="mt-2 flex flex-wrap gap-2">{s.topics.map((t) => <span key={t.key} className="rounded-md border border-line px-2 py-1 text-xs">{t.name}</span>)}</div>
      <div className="mt-8 flex flex-wrap gap-2 text-sm">
        <Link className="rounded-md border border-line px-3 py-1.5 hover:bg-sunken" to="/app/preferences">Notification preferences</Link>
        <Link className="rounded-md border border-line px-3 py-1.5 hover:bg-sunken" to="/app/topics">Manage topics</Link>
        <Link className="rounded-md border border-line px-3 py-1.5 hover:bg-sunken" to="/app/focus">Focus Mode</Link>
      </div>
      <p className="mt-8 text-xs text-muted">Name, programme and enrolment come from the registrar and can't be edited here.</p>
    </div>
  );
}

// ------------------------------------------------------------------ focus

function Countdown({ endsAt }: { endsAt: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = Math.max(0, new Date(endsAt).getTime() - now);
  const h = Math.floor(left / 3600000); const m = Math.floor((left % 3600000) / 60000); const s = Math.floor((left % 60000) / 1000);
  return <span className="font-mono text-5xl font-light tabular-nums tracking-tight">{h ? `${h}:` : ''}{String(m).padStart(2, '0')}:{String(s).padStart(2, '0')}</span>;
}

function Focus() {
  const toast = useToast();
  const status = useLoad(() => student.get<FocusStatus>('/inbox/focus-mode/status'), [], 4000);
  const summary = useLoad(() => student.get<FocusSummary | null>('/inbox/focus-mode/summary').catch(() => null), [status.data?.active]);
  const [until, setUntil] = useState('');
  const start = async (duration: string | number) => {
    try { await student.post('/inbox/focus-mode/start', { duration }); toast('ok', "You're focused. Non-critical updates will wait."); status.reload(); } catch (e) { toast('fail', (e as Error).message); }
  };
  const startUntil = (e: FormEvent) => {
    e.preventDefault();
    const [h, m] = until.split(':').map(Number);
    const end = new Date(); end.setHours(h, m, 0, 0);
    if (end.getTime() <= Date.now()) end.setDate(end.getDate() + 1);
    start(Math.max(1, Math.round((end.getTime() - Date.now()) / 60000)));
  };
  const end = async () => { try { await student.post('/inbox/focus-mode/end'); toast('ok', 'Welcome back. Here is what changed.'); status.reload(); summary.reload(); } catch (e) { toast('fail', (e as Error).message); } };
  const s = status.data;
  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Focus Mode</h1>
      <p className="mt-1 text-sm text-muted">Everyday updates wait until you're done, related ones are combined and repeats are dropped. Critical notices still reach you immediately.</p>
      <div className="mt-8 rounded-xl border border-line bg-surface p-6">
        {!s ? <Spinner /> : s.active && s.session ? (
          <div className="cne-fade flex flex-col items-center py-4 text-center">
            <p className="text-sm text-muted">You're focused</p>
            <Countdown endsAt={s.session.endsAt} />
            <p className="mt-2 text-sm text-muted">{s.heldCount} update{s.heldCount === 1 ? '' : 's'} held · ends {new Date(s.session.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
            <p className="mt-1 text-xs text-muted">We'll keep non-critical updates out of your way.</p>
            <Button variant="secondary" className="mt-6" onClick={end}>End now and catch up</Button>
          </div>
        ) : (
          <div>
            <p className="text-sm font-medium">Focus for</p>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[['30m', '30 min'], ['1h', '1 hour'], ['2h', '2 hours'], ['4h', '4 hours']].map(([d, l]) => <Button key={d} variant="secondary" onClick={() => start(d)}>{l}</Button>)}
            </div>
            <form className="mt-4 flex items-end gap-2" onSubmit={startUntil}>
              <Field label="Or until" htmlFor="until"><input id="until" type="time" required className={inputCls} value={until} onChange={(e) => setUntil(e.target.value)} /></Field>
              <Button type="submit">Start</Button>
            </form>
          </div>
        )}
      </div>
      <section className="mt-10">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">While you were focused</h2>
        <div className="mt-3">{summary.data ? <SummaryView s={summary.data} /> : <p className="text-sm text-muted">After your first session, a short summary of what changed appears here.</p>}</div>
      </section>
    </div>
  );
}

export function SummaryView({ s }: { s: FocusSummary }) {
  const suppressed = s.suppressed.acknowledged + s.suppressed.duplicates;
  return (
    <div className="cne-fade">
      <p className="text-lg font-semibold">{s.items.length === 0 ? 'Nothing new needed you.' : `${s.items.length} thing${s.items.length === 1 ? '' : 's'} changed`}</p>
      <p className="text-xs text-muted">{fmtDateTime(s.createdAt)} · from {s.heldCount} held update{s.heldCount === 1 ? '' : 's'}{suppressed ? ` · ${suppressed} redundant left out` : ''}</p>
      <ul className="mt-4 divide-y divide-line border-y border-line">
        {s.items.map((i) => (
          <li key={i.correlation} className="py-3">
            <div className="flex items-center gap-2"><p className="font-medium capitalize">{i.label}</p>{i.relatedEvents > 1 && <span className="text-xs text-primary">{i.relatedEvents} related updates</span>}</div>
            {i.changes.length > 0 ? i.changes.map((c) => <p key={c.field} className="text-sm"><span className="text-muted">{c.field} </span><span className="text-muted line-through">{String(c.from)}</span> → <strong>{String(c.to)}</strong></p>)
              : <p className="text-sm text-muted">{String(i.latest.summary ?? i.latest.title ?? '')}</p>}
          </li>
        ))}
      </ul>
      {s.interrupted.length > 0 && <p className="mt-3 text-sm text-muted"><Clock size={13} className="mr-1 inline" />Delivered immediately during focus: {s.interrupted.map((i) => i.label).join(', ')}</p>}
      <Link to="/app/inbox" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">Review updates</Link>
    </div>
  );
}
