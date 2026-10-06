<div align="center">

# Concourse

**Campus notifications for SRM University**

The exam moved. Every student knows — and nobody got ten emails about it.

[Quick start](#quick-start) · [Product tour](#product-tour) · [Architecture](#architecture) · [Verification](#verification) · [API](#api) · [Scale](#scale-measured)

</div>

---

## About

Concourse is a clean-room rebuild of a campus notification engine, built for HACKBACK V2 from a frozen seven-document specification (`../docs/`). It turns campus events — an exam room change, a closure, a fee deadline — into notifications that reach the right students fast, through the channels they chose, combined when they're related, and never lost or duplicated when something goes wrong.

The spec documents were never edited. Where they were silent or contradicted each other, the decision made is recorded under [Implementation assumptions](#implementation-assumptions) rather than left implicit.

## Quick start

Requires **Node.js 22.5+** (uses the built-in `node:sqlite`; developed on Node 26). No Redis, MongoDB or Docker required.

```bash
cd campus-notification-engine
npm install
npm run demo
```

This seeds a believable SRM campus — 5 departments, 8 courses, 4 clubs, 4 residences, 180 students, 11 workflows — and replays three days of campus events **through the real engine** on a controlled clock, so every digest, read receipt and delivery state in the UI is genuine, not a fixture. Then open:

| | URL | Sign in |
|---|---|---|
| **Landing** | `http://localhost:3000/` | — |
| **Student portal** | `http://localhost:3000/app` | `student_001` (Aditi Rao, CSE, Year 3) |
| **Staff console** | `http://localhost:3000/console` | API key — local default `campus-admin-api-key-change-in-production` |

For a plain (non-demo) run: `npm run seed && npm start`. The production UI build is committed in `public/`; after editing `web/`, rebuild with `npm run build:web`.

## Product tour

### For students — `/app`

- **Overview** — critical alerts pinned until opened, what needs attention, combined updates, upcoming dates, unread counts by category.
- **Inbox** — All / Unread / Critical / Archived, category filter, search, sort, mark-all-read. Each notification opens into a detail view with a *What changed* table (Previous → Updated), the full sequence for combined updates, click-tracked actions, *why you received this*, delivery state and related notifications.
- **Focus Mode** — hold everyday notifications for 30 min–4 h (or until a time); critical alerts still arrive; one catch-up summary — *"3 things changed"* — when the session ends.
- **Topics** — follow or unfollow clubs and services; enrolled courses, department and residence groups show read-only.
- **Preferences** — in-app and email, per category (Academic, Campus, Events, Administrative, Clubs), layered over sensible defaults.
- **Profile**, and new notifications that arrive live over a WebSocket.

### For staff — `/console`

- **Compose** — pick the kind of event, write what happened, target any combination of departments, years, courses, clubs, residences and services, and watch a **live student-count estimate** and an exact preview of what students will receive — channels, timing, Focus Mode behaviour — before publishing.
- **Overview** — *attention management* (delivered immediately, combined into digests, held by Focus Mode, suppressed as redundant, critical) and *engagement* (read and click-through rates, by category).
- **Events** — per-student **delivery lifecycle**: event → audience → workflow → timing → preference check → Focus Mode → delivery attempts → read.
- **Workflows**, shown as Event → Audience → Rules → Timing → Channels → Priority, plus Activity, Dead Letters, Provider Health, Subscribers and Webhooks.

Critical notifications (closures, security alerts) are visually distinct, explain why they bypassed preferences and Focus Mode, and are enforced at the engine level, not just in the UI.

## What it does

| Capability | Detail |
|---|---|
| **Ingest** | `202 Accepted`, de-duplicated by `transactionId` for 24 h via a unique index (concurrent duplicates collapse too) |
| **Fan-out** | explicit lists, topics or broadcast, chunked by 100, with per-recipient progress — a failed fan-out resumes instead of dropping people |
| **Digest** | first event in a window becomes the master; later ones merge in; one message goes out when the window closes, guarded by a partial unique index. Digests can also merge **across workflows** via a shared `groupScope` |
| **Preferences** | email / in-app, global or per category or per workflow, evaluated live on every send; critical workflows override mutes |
| **Delivery** | email via a provider adapter; in-app messages stored and **pushed live over WebSocket**, with polling as a fallback |
| **Retry** | 1 s / 5 s / 15 s backoff, 3 attempts, same idempotency key — never a new notification or message |
| **Provider protection** | a 100/s token bucket and a circuit breaker (opens after 5 consecutive failures, probes after 30 s); a held send never spends an attempt |
| **Dead-letter queue** | permanent failures and exhausted retries are parked with a reason; staff can retry (same job, same key — never a duplicate) or dismiss |
| **Observability** | activity log, per-event delivery status, dashboards, provider health, webhook audit |

Built with React 19, TypeScript, Vite and Tailwind 4, with self-hosted fonts (works offline). Light and dark themes, a responsive layout, keyboard focus states, `aria-live` announcements and a skip link. Credentials live only in `sessionStorage`; `localStorage` is used solely for the theme choice.

## Live verification

The three Killer Tests are automated (`npm run test:kt1`, `test:kt2`, `test:kt3`). For a live, clickable walkthrough, a **developer-only** page exists at `http://localhost:3000/internal/verify` — unlinked from the product and only served when `DEMO_MODE=true` (which `npm run demo` sets). Each card drives the real REST API and reads real database rows back to decide pass or fail.

| Card | What happens |
|---|---|
| Killer Test 1 | 10 events, nothing delivered while the window is open → 1 email + 1 in-app containing all 10; `sent 1, digested 9` |
| Killer Test 2 | student mutes email → email step `skipped`, zero provider attempts; in-app still delivered |
| Killer Test 3 | provider fails once → attempt 1 fails (500), attempt 2 succeeds, same idempotency key, exactly 1 email |
| Fix | 4 webhook requests — forged (401), unsigned (401), unverifiable provider (400), valid (200) — only the valid one changes state |
| Differentiator | Focus on → 4 updates held → critical alert arrives anyway → session ends → one catch-up, redundant item suppressed |
| G6 | 5 straight provider failures → circuit opens → held students keep their retry budget → after cooldown, all get exactly one email |
| G7 | permanent failure → dead-letter queue → staff retry → exactly 1 email, history preserved |
| G8 | three workflows sharing a digest group → 1 email naming all three |

All eight pass in the headless browser suite (`npm run test:e2e`).

## Fix — fail-closed webhook signatures

`POST /webhooks/:provider` handles *inbound* provider delivery callbacks (not the producer API).

| Situation | Response | Applied? |
|---|---|---|
| Valid signature | 200 | Yes |
| Invalid signature, or stale timestamp | 401 | No |
| Missing signature | 401 | No |
| No verifier for the provider | 400 | No |
| Verifier exists, no secret configured | 400 | No |
| Unsupported provider + explicit `WEBHOOK_ALLOW_UNVERIFIED_<PROVIDER>=true` | 202, recorded `unverified` | No |

Supported schemes: `generic` (HMAC-SHA256 over the raw body) and `mailgun` (HMAC-SHA256 of timestamp + token, with a tolerance window). Comparisons are constant-time; every request is audited without the signature or secret. Not covered: replay protection for the `generic` scheme, and verifiers for ECDSA-signed providers.

## Differentiator — Intelligent Focus Mode

While a session is active, non-critical deliveries are held. Critical ones arrive immediately — a `critical` workflow, `priority: "critical"`, or a rule like `minutesUntilExam < 30`. At session end, held events are grouped by the workflow's `correlationKey`; repeats are dropped, and facts already delivered by a critical alert (or read during the session) are suppressed. The student gets **one** catch-up notification through the normal pipeline, so mutes and retries still apply — it reports what changed (`room: A201 → H123`), not a replay of five messages.

## Architecture

```
 Browser (React SPA)  ── REST ──┐        ┌── WebSocket /ws (JWT) ── pushes in-app
                                ▼        ▼
                    Express (auth · console · demo · realtime)
                                │
POST /events/trigger → events (202) → worker tick → resumable fan-out
                                │
     notifications (unique per event+subscriber) + job chain: digest → email → in-app
                                │
  digest: one DELAYED master per (subscriber, scope, key, value) — partial unique index
  email:  preferences → Focus gate → provider guard (bucket + breaker) → provider (idempotency key)
          ├─ success  → messages (unique per subscriber+channel+key) + delivery_attempts
          ├─ transient → retry (1s/5s/15s) ── exhausted ─┐
          └─ permanent ───────────────────────────────────┴─→ dead_letters
  in-app: upsert message → event bus → WebSocket push
                                │
               SQLite (node:sqlite, WAL), schema via numbered migrations
```

| Path | Responsibility |
|---|---|
| `src/db.js` | schema, numbered migrations, transactions, prepared-statement cache |
| `src/engine/ingest.js` | validation, idempotent accept, bulk/broadcast, resumable fan-out |
| `src/engine/pipeline.js` | job chain, digest merge, claim/execute, retry, provider guard, dead-letter writes |
| `src/engine/deadletters.js` | list, retry, bulk retry, dismiss |
| `src/providers/guard.js` | token bucket + circuit breaker |
| `src/engine/focus.js` · `webhooks.js` · `subscribers.js` · `queries.js` | Focus Mode, webhook verification, preferences, read models |
| `src/http/` | REST routes, console/demo routes, WebSocket gateway, auth |
| `web/` | UI source (React + TypeScript), builds into `public/` |

Four identities are kept distinct throughout: **event** (`transaction_id`), **notification** (unique per event + subscriber), **delivery attempt** (unique per job + attempt number), and **provider result** (`provider_message_id` / `provider_status`).

## Verification

| Command | Proves | Result |
|---|---|---|
| `npm test` | 83 integration tests against a real engine, real SQLite, real HTTP and WebSocket | **83/83** |
| `npm run test:kt1` / `kt2` / `kt3` | the three Killer Tests | pass |
| `npm run test:gaps` | one named test per gap (G1–G8), plus migrations | pass |
| `npm run test:webhook` / `test:focus` | the Fix and the Differentiator | pass |
| `npm run test:e2e` | full headless-browser walkthrough: staff compose → student receives live, digest detail, search, preferences, topics, Focus Mode, every console screen, all 8 verification cards, zero console errors | **35/35** |
| `npm run lint` | eslint (server) | clean |
| `npm run typecheck:web` | TypeScript strict (UI) | clean |
| `npm run bench -- 30000` | 30,000-student broadcast | see [Scale](#scale-measured) |
| `npm run test:crash` | process killed mid-delivery, restarted on the same database | pass, see below |

`test:e2e` drives Edge or Chrome already on the machine via `playwright-core` — no browser download.

## Scale (measured)

`scripts/bench-broadcast.js` broadcasts one event (email + in-app) to N students on a real SQLite file, through the real worker loop, with an in-process stub provider so the measurement is of the engine rather than an SMTP server.

**Measured 2026-10-06**, one process, Node 26.4, Windows 11:

| Metric | 30,000 students | Target |
|---|---|---|
| API accept (`202`) | **2 ms** | < 500 ms ✔ |
| All notifications + job chains created | 2.7 s | — |
| First student notified | 2.7 s after accept | — |
| All 30,000 emails + 30,000 in-app messages delivered | **38.0 s** | — |
| Cost per 100 students | **127 ms** | < 1 s ✔ |
| Duplicate emails | **0** | 0 |

Delivery is depth-first — each student's in-app message follows their own email immediately rather than waiting behind every other student's. The benchmark surfaced and fixed a real O(n²) scan in job claiming (now three index-backed lookups), enabled `synchronous=NORMAL` under WAL, and cached prepared statements — together, roughly 5× faster. At the default 100 emails/s provider limit, a 30,000-student broadcast takes about 5 minutes by design.

**Crash recovery** (`npm run test:crash`): 3,000-student broadcast, server hard-killed mid-delivery, restarted on the same database.

| | Result |
|---|---|
| State at kill | 902 emails + 902 in-app delivered, 1 job mid-send |
| Recovery | 3.7 s (stale lock reclaimed) |
| Students with exactly one email / one in-app record | **3,000 / 3,000** |
| Duplicates, failed jobs, lost students | **0 / 0 / 0** |
| Provider calls | 3,001 — one idempotency key sent twice |

The one repeat is the single send in flight at the exact moment of the kill: accepted by the provider, but the result never committed before the process died. On restart it is re-sent with the **same idempotency key**; a provider that honours that key drops it, plain SMTP would not. This is the one duplicate the engine cannot prevent unilaterally — see [Known limitations](#known-limitations).

## API

Everything documented in `docs/API.md` is implemented; a repeated `transactionId` returns the cached `202` response with `"duplicate": true`. Additive routes (API-key protected unless noted):

| Route | Purpose |
|---|---|
| `PUT /admin/workflows/:id`, `GET /admin/workflows` | define workflows: steps, digest window/scope, critical rules |
| `PUT /admin/subscribers/:id`, `GET /admin/subscribers`, `PUT /admin/topics/:t/subscribers`, `GET /admin/topics` | students and topics |
| `GET /admin/stats`, `GET /admin/events` | overview, event list |
| `GET /admin/dead-letters`, `POST .../retry`, `POST .../dismiss` | dead-letter queue |
| `GET /admin/providers`, `POST /admin/providers/email/reset` | provider health |
| `GET /admin/webhooks` | webhook audit and config (never secrets) |
| `GET /inbox/feed`, `GET .../:id`, `POST .../read`, `.../click`, `POST /inbox/read-all` (student JWT) | the product inbox — category, priority, actions, why-received, engagement |
| `PATCH /inbox/preferences/categories/:category` (student JWT) | category preferences |
| `GET /inbox/topics`, `POST`/`DELETE .../follow`, `GET /inbox/profile` (student JWT) | topics and profile |
| `GET /admin/audiences`, `POST /admin/audiences/estimate`, `PUT /admin/audiences/:key` | audience catalogue, live estimate, multi-group targeting |
| `POST /inbox/focus-mode/start`/`end`, `GET .../status`/`summary` (student JWT) | Focus Mode |
| `POST /webhooks/:provider` (signed, no key) | inbound webhook verification |
| `GET /ws?token=<student JWT>` | real-time in-app push |
| `/admin/demo/*` | only when `DEMO_MODE=true`; 404 otherwise, refused in production |

## Implementation assumptions

1. **Storage** — SQLite (`node:sqlite`) with a DB-backed job table, in place of MongoDB + Redis/BullMQ. The spec allows "or similar" for the queue; this choice needs no infrastructure and is fully tested. The Mongo partial unique index maps directly to a SQLite partial unique index.
2. **Duplicate `transactionId`** — spec allows either 409 or a cached 202; this implementation returns the cached 202.
3. **`POST /inbox/session`** requires the API key by default, since the documented "public" behaviour would let anyone impersonate any student. `INBOX_SESSION_AUTH=public` restores it; `DEMO_MODE=true` defaults to it so the demo works end-to-end.
4. **In-app retry budget** matches email's (rather than 1), since the upsert makes retries harmless.
5. **A failed email still proceeds** to the next step, and is also parked in the dead-letter queue.
6. **Digest window** starts at the first event's submission; a digest step must be first in its workflow.
7. **Cancelling** an event removes only its own content from a shared digest master.
8. A **critical workflow** ignores mutes and Focus Mode; a **critical event** (priority or rule) bypasses Focus Mode only.
9. **Scope exceeded on purpose** — the spec lists a preferences UI, workflow designer and analytics as out of scope; this build includes a preferences screen and a JSON-based workflow editor (not a visual designer), and a polled dashboard (not streaming analytics).
10. **UI routes** are `/app` and `/console` (`/admin/*` is already the API namespace).
11. **Product metadata beyond the spec** — workflow category, priority, display name and actions; event priority levels `low`–`critical`; student department/year/programme; a topic catalogue.
12. **Brand** — "Concourse" and its visual identity are original; nothing is taken from the reference product.

## Known limitations

- Single process — claim logic is written to be multi-worker safe (conditional `UPDATE`, indexed claims) but untested with more than one.
- A crash between "provider accepted" and "result saved" re-sends the in-flight email with the same idempotency key (measured: 1 of 3,000). Only a provider honouring that key fully prevents the duplicate.
- The email provider is a console stub unless `SMTP_HOST` is set; the SMTP adapter has not been run against a real mail server.
- Circuit-breaker and rate-limiter state live in memory and reset on restart (safe default: starts closed).
- Webhook replay protection exists only for the timestamp-based scheme.
- `Dockerfile` is provided but not built in this environment.
- Not built: scheduled digests, preference history, multi-process tests, Mailpit email capture.

## Configuration

See `.env.example` (names only, no values). Notable settings: `DEMO_MODE`, `EMAIL_RATE_PER_SEC`, `EMAIL_BREAKER_THRESHOLD`, `EMAIL_BREAKER_COOLDOWN_MS`, `WEBHOOK_SECRET_<PROVIDER>`, `INBOX_SESSION_AUTH`. In production, the server refuses to start with placeholder secrets or `DEMO_MODE` enabled.

---

<div align="center">

Built for SRM University · HACKBACK V2

</div>
