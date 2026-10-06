// Thin typed client over the engine's REST API. Credentials live in sessionStorage only
// (cleared when the tab closes), never in localStorage.

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const KEY_STORE = 'cne.adminKey';
const TOKEN_STORE = 'cne.studentToken';
const STUDENT_STORE = 'cne.studentId';

const read = (k: string) => {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v == null) sessionStorage.removeItem(k);
    else sessionStorage.setItem(k, v);
  } catch {
    /* storage unavailable: credentials stay in memory for this page only */
  }
};

let adminKey = read(KEY_STORE);
let studentToken = read(TOKEN_STORE);
let studentId = read(STUDENT_STORE);
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export const session = {
  get adminKey() { return adminKey; },
  get studentToken() { return studentToken; },
  get studentId() { return studentId; },
  setAdminKey(k: string | null) { adminKey = k; write(KEY_STORE, k); notify(); },
  setStudent(token: string | null, id: string | null) {
    studentToken = token; studentId = id; write(TOKEN_STORE, token); write(STUDENT_STORE, id); notify();
  },
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
};

type Auth = 'admin' | 'student' | 'none';

async function request<T>(method: string, path: string, body?: unknown, auth: Auth = 'admin'): Promise<T> {
  const headers: Record<string, string> = {};
  const token = auth === 'admin' ? adminKey : auth === 'student' ? studentToken : null;
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) {
    const msg = (json && typeof json === 'object' && 'message' in json ? String((json as { message: unknown }).message) : '') || `HTTP ${res.status}`;
    if (res.status === 401) {
      if (auth === 'admin') session.setAdminKey(null);
      if (auth === 'student') session.setStudent(null, null);
    }
    throw new ApiError(res.status, msg, json);
  }
  return json as T;
}

export const admin = {
  get: <T>(p: string) => request<T>('GET', p, undefined, 'admin'),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}, 'admin'),
  put: <T>(p: string, b: unknown) => request<T>('PUT', p, b, 'admin'),
  del: <T>(p: string) => request<T>('DELETE', p, undefined, 'admin'),
};
export const student = {
  get: <T>(p: string) => request<T>('GET', p, undefined, 'student'),
  post: <T>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}, 'student'),
  patch: <T>(p: string, b?: unknown) => request<T>('PATCH', p, b ?? {}, 'student'),
};

/** Mint a student session. Sends the API key if one is known (needed unless the server is in public/demo mode). */
export async function startStudentSession(subscriberId: string, organizationId = 'campus-org') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (adminKey) headers.authorization = `Bearer ${adminKey}`;
  const res = await fetch('/inbox/session', { method: 'POST', headers, body: JSON.stringify({ organizationId, subscriberId }) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.message || `HTTP ${res.status}`, json);
  session.setStudent(json.token, json.subscriberId);
  return json as { token: string; subscriberId: string; expiresIn: number };
}

/** Same as startStudentSession but returns the token without touching the signed-in student. */
export async function mintToken(subscriberId: string): Promise<string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (adminKey) headers.authorization = `Bearer ${adminKey}`;
  const res = await fetch('/inbox/session', { method: 'POST', headers, body: JSON.stringify({ organizationId: 'campus-org', subscriberId }) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.message || `HTTP ${res.status}`, json);
  return json.token;
}

/** Call an inbox endpoint as an arbitrary student (Demo Lab). */
export async function asStudent<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.message || `HTTP ${res.status}`, json);
  return json as T;
}

// ---- shapes (subset of what the server returns) ----
export interface InboxItem {
  messageId: string; notificationId: string; workflowId: string; content: string; subject: string;
  seen: boolean; archived: boolean; createdAt: string; updatedAt: string;
}
export interface Prefs { subscriberId: string; global: { email: boolean; inApp: boolean }; workflows: Record<string, { email?: boolean; inApp?: boolean }> }
export interface FocusStatus { active: boolean; heldCount: number; session: null | { sessionId: number; startsAt: string; endsAt: string; status: string } }
export interface SummaryItem {
  correlation: string; label: string; latest: Record<string, unknown>; changes: { field: string; from: unknown; to: unknown }[];
  relatedEvents: number; actionRequired: boolean; action: string | null;
}
export interface FocusSummary {
  sessionId: number; createdAt: string; subject: string; text: string; items: SummaryItem[];
  interrupted: { label: string; count: number }[]; suppressed: { acknowledged: number; duplicates: number }; sent: boolean; heldCount: number;
}
export interface ActivityEvent {
  timestamp?: string; at?: string; event: string; status: string; subscriberId?: string; workflowId?: string;
  stepType?: string; attempt?: number; details?: string; error?: string; transactionId?: string;
}
export interface Workflow { id: number; identifier: string; steps: Record<string, unknown>[]; critical: boolean; correlationKey: string | null; criticalRules: unknown[] }
