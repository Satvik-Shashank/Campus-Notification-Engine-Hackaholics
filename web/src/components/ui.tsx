import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export { cx };

// ---------------------------------------------------------------- data hooks

/** Load data and optionally re-poll. Returns { data, error, loading, reload }. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = [], pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async () => {
    try {
      const d = await fnRef.current();
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    setLoading(true);
    reload();
    if (!pollMs) return undefined;
    const id = setInterval(reload, pollMs);
    return () => clearInterval(id);
  }, deps); // callers pass the values that should trigger a reload
  return { data, error, loading, reload, setData };
}

// ---------------------------------------------------------------- toasts

type Toast = { id: number; kind: 'ok' | 'fail' | 'info'; text: string };
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} role="status" className={cx('rounded-lg border px-4 py-3 text-sm shadow-lg',
            t.kind === 'ok' && 'border-ok/30 bg-ok-soft text-ok',
            t.kind === 'fail' && 'border-fail/30 bg-fail-soft text-fail',
            t.kind === 'info' && 'border-info/30 bg-info-soft text-info')}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------------------------------------------------------------- primitives

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' };
export function Button({ variant = 'primary', size = 'md', className, ...rest }: BtnProps) {
  return (
    <button
      {...rest}
      className={cx('inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-4 py-2 text-sm',
        variant === 'primary' && 'bg-primary text-primary-ink hover:opacity-90',
        variant === 'secondary' && 'border border-line bg-surface text-ink hover:bg-sunken',
        variant === 'ghost' && 'text-primary hover:bg-primary-soft',
        variant === 'danger' && 'border border-fail/40 bg-fail-soft text-fail hover:opacity-90',
        className)}
    />
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-xl border border-line bg-surface p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]', className)}>
      {(title || actions) && (
        <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

const TONE: Record<string, string> = {
  ok: 'bg-ok-soft text-ok', fail: 'bg-fail-soft text-fail', warn: 'bg-warn-soft text-warn', info: 'bg-info-soft text-info',
  muted: 'bg-sunken text-muted', accent: 'bg-accent-soft text-accent', primary: 'bg-primary-soft text-primary',
};
const STATUS_TONE: Record<string, string> = {
  sent: 'ok', success: 'ok', delivered: 'ok', completed: 'ok', processed: 'ok', closed: 'ok', valid: 'ok', accepted: 'ok', retried: 'ok',
  failed: 'fail', failure: 'fail', open: 'fail', rejected: 'fail', invalid: 'fail', missing: 'fail', partially_sent: 'warn',
  retrying: 'warn', skipped: 'muted', pending: 'info', processing: 'info', queued: 'info', delayed: 'info', half_open: 'warn',
  digested: 'primary', merged: 'primary', held: 'accent', deferred: 'accent', summarized: 'primary', canceled: 'muted',
  info: 'info', unsupported: 'warn', unconfigured: 'warn', unverified: 'warn', dismissed: 'muted', critical: 'accent', normal: 'muted',
};
export function Badge({ children, tone }: { children: ReactNode; tone?: string }) {
  const t = tone ?? STATUS_TONE[String(children)] ?? 'muted';
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', TONE[t] ?? TONE.muted)}>{children}</span>;
}

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <label className="block" htmlFor={htmlFor}>
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}
export const inputCls = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted/70 focus:border-primary focus:outline-none';

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cx('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50', checked ? 'bg-primary' : 'bg-line')}>
      <span className={cx('inline-block h-5 w-5 rounded-full bg-surface shadow transition-transform', checked ? 'translate-x-5' : 'translate-x-0.5')} />
    </button>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-sm text-muted">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-primary" />{label}…
    </span>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-6 py-10 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 text-sm text-muted">{children}</div>}
    </div>
  );
}

export function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return <p role="alert" className="rounded-lg bg-fail-soft px-3 py-2 text-sm text-fail">{error}</p>;
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cx('font-mono text-[0.8rem]', className)}>{children}</code>;
}

export function Json({ value }: { value: unknown }) {
  return <pre className="max-h-80 overflow-auto rounded-lg bg-sunken p-3 font-mono text-xs leading-relaxed">{JSON.stringify(value, null, 2)}</pre>;
}

export function Table({ head, rows, empty = 'Nothing here yet.' }: { head: ReactNode[]; rows: ReactNode[][]; empty?: string }) {
  if (!rows.length) return <Empty title={empty} />;
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-left text-sm">
        <thead className="bg-sunken text-xs uppercase tracking-wide text-muted">
          <tr>{head.map((h, i) => <th key={i} scope="col" className="px-3 py-2 font-medium">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line align-top">
              {r.map((c, j) => <td key={j} className="px-3 py-2">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STAT_TONE: Record<string, string> = { ok: 'text-ok', fail: 'text-fail', warn: 'text-warn', accent: 'text-accent', primary: 'text-primary' };

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className={cx('mt-1 text-2xl font-semibold tabular-nums', tone && STAT_TONE[tone])}>{value}</p>
    </div>
  );
}

export const fmtTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleTimeString() : '—');
export const fmtDateTime = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

export function PageTitle({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="font-display text-3xl font-semibold tracking-tight">{title}</h1>
      {children && <p className="mt-1 max-w-3xl text-sm text-muted">{children}</p>}
    </div>
  );
}
