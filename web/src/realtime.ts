import { useEffect, useRef, useState } from 'react';
import { session } from './api';

export type LiveState = 'connecting' | 'live' | 'offline';

/**
 * Subscribe to the server's WebSocket push for the signed-in student. Reconnects with backoff.
 * The caller keeps a slow poll as a fallback, so a dropped socket only delays updates.
 */
export function useLiveNotifications(onNotification: (n: { subject: string; content: string }) => void): LiveState {
  const [state, setState] = useState<LiveState>('connecting');
  const cb = useRef(onNotification);
  cb.current = onNotification;
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const token = session.studentToken;
      if (!token || stopped) return;
      setState('connecting');
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${window.location.host}/ws?token=${encodeURIComponent(token)}`);
      ws.onopen = () => { attempt = 0; setState('live'); };
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(String(e.data));
          if (msg.type === 'notification') cb.current(msg);
        } catch { /* ignore malformed frames */ }
      };
      ws.onclose = () => {
        setState('offline');
        if (stopped) return;
        attempt += 1;
        timer = setTimeout(connect, Math.min(30000, 1000 * 2 ** Math.min(attempt, 5)));
      };
    };
    connect();
    return () => { stopped = true; clearTimeout(timer); ws?.close(); };
  }, []);
  return state;
}
