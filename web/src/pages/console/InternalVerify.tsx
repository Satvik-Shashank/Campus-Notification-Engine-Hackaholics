import { Link } from 'react-router-dom';
import { session } from '../../api';
import { useLoad } from '../../components/ui';
import { DemoLab } from './DemoLab';

/**
 * Developer-only verification page. Not linked from the product, and the server only exposes the
 * endpoints it uses when started with DEMO_MODE=true (never in production).
 */
export function InternalVerify() {
  const enabled = useLoad(async () => {
    if (!session.adminKey) return false;
    const r = await fetch('/admin/demo', { headers: { authorization: `Bearer ${session.adminKey}` } });
    return r.ok;
  }, []);
  if (!session.adminKey) return <p className="p-8 text-sm">Sign in to the <Link className="underline" to="/console">operator console</Link> first.</p>;
  if (enabled.loading) return null;
  if (!enabled.data) return <p className="p-8 text-sm text-muted">Not available on this server.</p>;
  return <main className="mx-auto max-w-6xl px-6 py-8"><DemoLab /></main>;
}
