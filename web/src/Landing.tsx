import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, BookOpen, Check, Focus, GraduationCap, Inbox, Layers, Megaphone, Send, Settings2, Sparkles, Users } from 'lucide-react';
import { useLoad } from './components/ui';
import { ThemeToggle, useTheme } from './components/Shell';

function Mark() {
  return (
    <span aria-hidden className="relative grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-ink">
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 20V10a8 8 0 0 1 16 0v10" /><path d="M9 20v-6a3 3 0 0 1 6 0v6" /></svg>
      <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-gold ring-2 ring-white" />
    </span>
  );
}

/**
 * One-hue indigo field with a fine canvas-grain texture and two restrained bands — a campus skyline
 * silhouette anchors the bottom edge instead of a rainbow of waves.
 */
function Waves() {
  return (
    <svg aria-hidden className="absolute inset-0 h-full w-full" viewBox="0 0 1440 820" preserveAspectRatio="none">
      <defs>
        <linearGradient id="w1" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stopColor="#4338ca" /><stop offset="1" stopColor="#4f46e5" /></linearGradient>
        <linearGradient id="w2" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stopColor="#3730a3" /><stop offset="1" stopColor="#4338ca" /></linearGradient>
        <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" stitchTiles="stitch" /><feColorMatrix type="saturate" values="0" /><feComponentTransfer><feFuncA type="linear" slope="0.05" /></feComponentTransfer></filter>
      </defs>
      <rect width="1440" height="820" fill="url(#w1)" />
      <path d="M0 540 C 320 480 540 610 840 575 S 1280 500 1440 540 V 820 H 0 Z" fill="url(#w2)" opacity=".6" />
      <path d="M0 700 C 340 660 600 750 900 720 S 1300 670 1440 700 V 820 H 0 Z" fill="#f7f7fc" />
      <rect width="1440" height="820" filter="url(#grain)" />
    </svg>
  );
}

const FLOWS = [
  { icon: <Send size={18} />, n: '01', t: 'Publish', s: 'Staff describe what happened.', items: ['Pick the kind of event', 'Write what changed', 'Choose courses, years or clubs'], foot: 'Live audience count' },
  { icon: <Layers size={18} />, n: '02', t: 'Combine', s: 'Related updates become one.', items: ['Room, time and seating changes merge', 'Repeats are dropped', 'Nothing waits longer than its window'], foot: 'One message, not five' },
  { icon: <Settings2 size={18} />, n: '03', t: 'Respect', s: 'Every student decides how.', items: ['In-app and email per category', 'Focus Mode holds the everyday', 'Topics they choose to follow'], foot: 'Preferences checked at send time' },
  { icon: <Check size={18} />, n: '04', t: 'Deliver', s: 'Reliably, exactly once.', items: ['Retries reuse the same key', 'Outages pause, not fail', 'Every step is on the record'], foot: 'Full delivery lifecycle' },
];

const KINDS = [
  { icon: <GraduationCap size={18} />, tone: 'text-primary bg-primary-soft', label: 'Academic', t: 'Exams and classes', s: 'Timetable changes arrive as one clear before-and-after.', cat: 'academic' },
  { icon: <AlertTriangle size={18} />, tone: 'text-accent bg-accent-soft', label: 'Critical', t: 'Closures and safety', s: 'Always delivered, even through mutes and Focus Mode.', cat: 'campus' },
  { icon: <Users size={18} />, tone: 'text-primary bg-primary-soft', label: 'Community', t: 'Clubs and events', s: 'Only from the clubs and topics a student follows.', cat: 'clubs' },
  { icon: <BookOpen size={18} />, tone: 'text-ink bg-sunken', label: 'Administrative', t: 'Fees and notices', s: 'Deadlines with the action one tap away.', cat: 'administrative' },
];

const PILLS = ['In-app inbox', 'University email', 'Combined updates', 'Focus Mode', 'Topics', 'Critical alerts', 'Category preferences', 'Delivery lifecycle', 'Live updates'];

export function Landing() {
  useTheme();
  const health = useLoad(() => fetch('/health').then((r) => r.ok), []);
  return (
    <div className="min-h-screen">
      <header className="fixed inset-x-0 top-3 z-40 px-3">
        <nav aria-label="Main" className="mx-auto flex max-w-6xl items-center gap-4 rounded-2xl border border-white/60 bg-white/75 px-4 py-2.5 shadow-[0_8px_30px_-12px_rgba(15,23,42,.25)] backdrop-blur-xl dark:border-white/10 dark:bg-surface/80">
          <Link to="/" className="flex items-center gap-2.5">
            <Mark />
            <span className="text-lg font-bold tracking-tight">Concourse</span>
            <span className="hidden text-[10px] font-semibold uppercase tracking-[.18em] text-muted sm:inline">SRM University</span>
          </Link>
          <div className="ml-auto hidden items-center gap-1 rounded-xl border border-line bg-sunken/70 p-1 text-sm md:flex">
            {[['#how', 'How it works'], ['#kinds', 'Updates'], ['#focus', 'Focus Mode']].map(([h, l], i) => (
              <a key={h} href={h} className={i === 0 ? 'rounded-lg bg-surface px-3 py-1 font-medium text-primary shadow-sm' : 'rounded-lg px-3 py-1 text-muted hover:text-ink'}>{l}</a>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2 md:ml-2">
            <Link to="/console" className="hidden rounded-lg px-3 py-1.5 text-sm font-medium text-muted hover:text-ink sm:block">Staff</Link>
            <Link to="/app" className="rounded-lg bg-primary px-3.5 py-1.5 text-sm font-semibold text-primary-ink shadow-sm hover:opacity-90">Student portal</Link>
            <ThemeToggle />
          </div>
        </nav>
      </header>

      <section id="home" className="relative overflow-hidden pt-28">
        <Waves />
        <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-6 pb-40 pt-10 lg:grid-cols-[1.05fr_1fr]">
          <div className="text-white">
            <span className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1.5 text-[11px] font-bold uppercase tracking-[.14em] text-primary shadow">
              <span className="grid h-5 w-5 place-items-center rounded-full bg-primary text-white"><Sparkles size={11} /></span>Campus notifications, done right
            </span>
            <h1 className="mt-6 text-5xl font-bold leading-[1.02] tracking-[-0.045em] sm:text-6xl">
              Every student informed.<br />
              <span className="relative inline-block">Nobody overwhelmed.<span className="absolute -bottom-2 left-0 h-1.5 w-full rounded-full bg-white/70" /></span>
            </h1>
            <p className="mt-7 max-w-xl text-lg leading-relaxed text-white/90">
              Concourse turns SRM's exam changes, closures and campus news into calm, clear notifications. Related updates are combined, preferences respected, and critical alerts always get through.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/app" className="inline-flex items-center gap-2 rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-ink shadow-lg hover:bg-white/90">Student portal <ArrowRight size={15} /></Link>
              <Link to="/console" className="rounded-lg border-2 border-white/80 bg-white/10 px-4 py-2 text-sm font-semibold text-white backdrop-blur hover:bg-white/20">Staff console</Link>
            </div>
            <div className="mt-6 flex flex-wrap gap-2">
              {['One update, not five', 'Students choose how', 'Critical always arrives'].map((t) => (
                <span key={t} className="inline-flex items-center gap-2 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-ink shadow"><span className="grid h-4 w-4 place-items-center rounded-full bg-primary-soft text-primary"><Check size={10} /></span>{t}</span>
              ))}
            </div>
            <p className="mt-6 text-xs text-white/70">Service status: {health.data ? 'operational' : health.loading ? 'checking…' : 'unreachable'}</p>
          </div>

          <div className="relative hidden lg:block">
            <div className="rounded-2xl border border-white/70 bg-white/95 shadow-[0_30px_60px_-20px_rgba(30,20,90,.45)] backdrop-blur dark:bg-surface/95">
              <div className="flex items-center gap-2 border-b border-line px-5 py-3 text-xs text-muted"><span className="h-2 w-2 rounded-full bg-accent/70" /><span className="h-2 w-2 rounded-full bg-gold/70" /><span className="h-2 w-2 rounded-full bg-primary/60" /><span className="ml-2">Aditi's inbox · CSE, Year 3</span></div>
              <div className="p-5">
                <p className="text-sm font-semibold text-ink">Needs your attention</p>
                <ul className="mt-3 space-y-2 text-sm">
                  {[
                    ['Exam', 'DBMS: 4 updates, now 2:00 PM · AB3-204', 'bg-primary-soft text-primary'],
                    ['Fees', 'Hostel fee due in 7 days', 'bg-sunken text-ink'],
                    ['Transport', 'Route 4 running 15 minutes late', 'bg-sunken text-ink'],
                  ].map(([tag, text, tone]) => (
                    <li key={tag} className="flex items-center gap-3 rounded-lg border border-line bg-paper/60 px-3 py-2.5">
                      <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${tone}`}>{tag}</span><span className="truncate font-medium text-ink">{text}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-4 flex flex-wrap gap-4 border-t border-line pt-3 text-xs text-muted">
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-primary" />Combined</span>
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-accent" />Critical</span>
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-ok" />Delivered</span>
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-gold" />Held</span>
                </div>
              </div>
            </div>
            {[
              ['-left-10 -top-8', <Layers key="l" size={15} />, '4 updates combined', 'Room, time, seating, reporting', 'bg-primary-soft text-primary'],
              ['-right-6 top-1/2', <AlertTriangle key="a" size={15} />, 'Critical: delivered now', 'Bypassed Focus Mode', 'bg-accent-soft text-accent'],
              ['-bottom-10 left-6', <Focus key="f" size={15} />, 'Held while focused', 'Summary at 5:00 PM', 'bg-sunken text-ink'],
            ].map(([pos, icon, t, s, tone]) => (
              <div key={String(t)} className={`absolute ${pos} flex items-center gap-3 rounded-xl border border-line bg-white px-3.5 py-2.5 shadow-[0_12px_30px_-12px_rgba(15,23,42,.35)] dark:bg-surface`}>
                <span className={`grid h-8 w-8 place-items-center rounded-lg ${tone}`}>{icon}</span>
                <span><span className="block text-sm font-semibold text-ink">{t}</span><span className="block text-xs text-muted">{s}</span></span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section aria-label="Capabilities" className="relative -mt-16 overflow-hidden py-6">
        <div className="cne-marquee flex w-max gap-3">
          {[...PILLS, ...PILLS].map((p, i) => <span key={i} className="whitespace-nowrap rounded-full border border-line bg-surface px-5 py-2 text-sm font-semibold text-ink shadow-sm">{p}</span>)}
        </div>
        <p className="mt-4 text-center text-sm text-muted">Built for SRM's students, faculty and administration.</p>
      </section>

      <main>
        <section id="how" className="mx-auto max-w-6xl px-6 py-20">
          <p className="text-center text-xs font-bold uppercase tracking-[.18em] text-primary">How it works</p>
          <h2 className="mt-3 text-center text-4xl font-bold tracking-[-0.04em]">Four simple steps</h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-muted">From the moment staff publish a change to the moment a student reads it, every step is visible and every promise is kept.</p>
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FLOWS.map((f) => (
              <div key={f.n} className="flex flex-col rounded-2xl border border-line bg-surface p-6 shadow-[0_1px_2px_rgba(15,23,42,.04)] transition-transform hover:-translate-y-0.5">
                <div className="flex items-start justify-between"><span className="grid h-11 w-11 place-items-center rounded-xl bg-primary-soft text-primary">{f.icon}</span><span className="text-3xl font-bold text-line">{f.n}</span></div>
                <h3 className="mt-5 text-xl font-bold tracking-tight">{f.t}</h3>
                <p className="mt-1 text-sm font-medium text-ink/80">{f.s}</p>
                <ul className="mt-4 space-y-2 text-sm text-muted">{f.items.map((i) => <li key={i} className="flex gap-2"><Check size={14} className="mt-0.5 shrink-0 text-primary" />{i}</li>)}</ul>
                <p className="mt-auto border-t border-line pt-4 text-xs font-semibold text-primary">{f.foot}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="kinds" className="border-y border-line bg-surface/60 py-20">
          <div className="mx-auto max-w-6xl px-6">
            <p className="text-center text-xs font-bold uppercase tracking-[.18em] text-primary">What students receive</p>
            <h2 className="mt-3 text-center text-4xl font-bold tracking-[-0.04em]">Every kind of campus update</h2>
            <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {KINDS.map((k) => (
                <div key={k.label} className="rounded-2xl border border-line bg-surface p-6">
                  <span className={`grid h-10 w-10 place-items-center rounded-xl ${k.tone}`}>{k.icon}</span>
                  <p className={`mt-4 text-[11px] font-bold uppercase tracking-[.14em] ${k.tone.split(' ')[0]}`}>{k.label}</p>
                  <h3 className="mt-1 text-lg font-bold tracking-tight">{k.t}</h3>
                  <p className="mt-1 text-sm text-muted">{k.s}</p>
                  <Link to={`/app/inbox?category=${k.cat}`} className={`mt-4 inline-flex items-center gap-1 text-sm font-semibold ${k.tone.split(' ')[0]}`}>Explore <ArrowRight size={14} /></Link>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="focus" className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-20 lg:grid-cols-2">
          <div>
            <p className="text-xs font-bold uppercase tracking-[.18em] text-primary">Focus Mode</p>
            <h2 className="mt-3 text-4xl font-bold tracking-[-0.04em]">Study in peace. Catch up in one glance.</h2>
            <p className="mt-4 text-muted">Everyday updates wait, related ones are merged, and repeats are dropped. When the session ends, students see what actually changed, not a pile of messages.</p>
            <Link to="/app/focus" className="mt-6 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-ink">Try Focus Mode <ArrowRight size={15} /></Link>
          </div>
          <div className="rounded-2xl border border-line bg-surface p-6 shadow-[0_20px_50px_-24px_rgba(79,70,229,.35)]">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted">While you were focused</p>
            <p className="mt-1 text-2xl font-bold tracking-tight">3 things changed</p>
            <ul className="mt-4 divide-y divide-line text-sm">
              <li className="py-3"><p className="font-semibold">DBMS examination</p><p className="text-muted">Time <s>10:00 AM</s> → <strong className="text-ink">2:00 PM</strong></p></li>
              <li className="py-3"><p className="font-semibold">Campus shuttle</p><p className="text-muted">Route 4 delayed by 15 minutes</p></li>
              <li className="py-3"><p className="font-semibold">Coding Club</p><p className="text-muted">Contest registration closes at 6 PM</p></li>
            </ul>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-6 py-8 text-sm text-muted">
          <Mark /><span className="font-semibold text-ink">Concourse</span><span>Campus notifications for SRM University</span>
          <span className="ml-auto flex gap-4"><Link to="/app" className="hover:text-ink"><Inbox size={14} className="mr-1 inline" />Students</Link><Link to="/console" className="hover:text-ink"><Megaphone size={14} className="mr-1 inline" />Staff</Link></span>
        </div>
      </footer>
    </div>
  );
}
