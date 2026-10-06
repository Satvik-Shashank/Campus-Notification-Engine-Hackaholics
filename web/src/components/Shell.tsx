import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { cx } from './ui';

export function useTheme() {
  const [dark, setDark] = useState(() => {
    try {
      const saved = localStorage.getItem('cne.theme');
      if (saved) return saved === 'dark';
    } catch { /* ignore */ }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  });
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try { localStorage.setItem('cne.theme', dark ? 'dark' : 'light'); } catch { /* ignore */ }
  }, [dark]);
  return [dark, setDark] as const;
}

export function Logo({ sub }: { sub?: string }) {
  return (
    <Link to="/" className="flex items-center gap-2.5">
      <span aria-hidden className="relative grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-ink">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M4 20V10a8 8 0 0 1 16 0v10" /><path d="M9 20v-6a3 3 0 0 1 6 0v6" /></svg>
        <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-gold ring-2 ring-surface" />
      </span>
      <span className="leading-tight">
        <span className="block text-lg font-bold tracking-tight">Concourse</span>
        {sub && <span className="block text-[11px] text-muted">{sub}</span>}
      </span>
    </Link>
  );
}

export function ThemeToggle() {
  const [dark, setDark] = useTheme();
  return (
    <button type="button" onClick={() => setDark(!dark)} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      className="rounded-lg border border-line px-2.5 py-1.5 text-xs text-muted hover:bg-sunken">
      {dark ? '☀ Light' : '☾ Dark'}
    </button>
  );
}

export interface NavItem { to: string; label: string; badge?: ReactNode; end?: boolean; icon?: ReactNode }

export function Shell({ sub, nav, right, children }: { sub: string; nav: NavItem[]; right?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-h-screen md:grid md:grid-cols-[240px_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2">Skip to content</a>
      <aside className="border-b border-line bg-surface/80 backdrop-blur md:sticky md:top-0 md:h-screen md:border-b-0 md:border-r">
        <div className="flex items-center justify-between px-4 py-4">
          <Logo sub={sub} />
          <button className="rounded-lg border border-line px-2 py-1 text-sm md:hidden" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="side-nav">Menu</button>
        </div>
        <nav id="side-nav" aria-label="Main" className={cx('px-2 pb-4 md:block', open ? 'block' : 'hidden')}>
          {nav.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} onClick={() => setOpen(false)}
              className={({ isActive }) => cx('mb-0.5 flex items-center justify-between rounded-lg px-3 py-2 text-sm',
                isActive ? 'bg-primary-soft font-semibold text-primary' : 'text-muted hover:bg-sunken hover:text-ink')}>
              <span className="flex items-center gap-2.5">{n.icon && <span className="opacity-70">{n.icon}</span>}{n.label}</span>{n.badge}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-[57px] items-center justify-end gap-3 border-b border-line bg-paper/85 px-6 backdrop-blur">
          {right}
          <ThemeToggle />
        </header>
        <main id="main" className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
