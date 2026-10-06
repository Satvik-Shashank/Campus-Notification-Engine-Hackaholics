# HACKBACK code review · DBG-642 · Campus Notification Engine

- Reviewed at: 2026-10-06T08:36:52Z (2026-10-06T14:06:52 IST)
- Judged commit: 8ac219b91df0d5b44e1afa3942a10512b80cc29e (2026-10-06T12:49:32+05:30) · the last commit before the code freeze
- Reviewer: AI agent run by a HACKBACK judge

### DBG-642 · Campus Notification Engine
Commit: `8ac219b91df0d5b44e1afa3942a10512b80cc29e` · 2026-10-06T12:49:32+05:30 · Clean-room: OK

| Section | Score | Why (path:line) |
|---|---|---|
| A. Core flow | 30/30 | Event->workflow wired end-to-end: ingest.js:157-215 (fan-out), pipeline.js:180-199 (notification+job chain creation), pipeline.js:354-426 (email delivery), pipeline.js:331-352 (in-app + WebSocket push). Per-student channel prefs evaluated at run time: subscribers.js:139-152 (resolve()), checked in pipeline.js:439-444. Digest groups bursts: pipeline.js:76-156 (merge into master, releaseDueDigests() at line 144). Retry with backoff 1s/5s/15s: pipeline.js:299-329 (recordFailure()), config config.js:47. In-app inbox exposed via GET /inbox/notifications -> app.js:129. No mocks or stubs in the hot path; console email provider clearly labelled a local-only stub. |
| B. Killer Tests | 30/30 | All three pass under node --test (run live during this review). |
| C. Two improvements | 20/20 | Fix: fail-closed webhook verification; Differentiator: Intelligent Focus Mode. Both named in SUBMISSION.md and proven by passing test suites. |
| D. Built from their docs | 9/10 | All routes in API.md table are implemented and match exactly. PRD acceptance criteria (202 accept, async fan-out, preferences, digest, retries, dedup, in-app inbox) all present. DATA_MODEL entities (subscribers, events, notifications, jobs, messages, preferences, delivery_attempts, dead_letters, focus_sessions, held_events) all present in db.js:7-237. Minor drift: API.md lists POST /inbox/session as Public but code defaults to api_key mode with an explicit opt-in -- documented as an implementation assumption. Scope beyond the PRD (console UI, focus mode, G6-G8 extras) is additive only. |
| E. Engineering | 9/10 | Input validation on every producer route (ingest.js:20-59). API-key guard on all admin/trigger routes (app.js:67-105). JWT verification on all subscriber routes (auth.js:54-63), subscriber scope enforced. No committed secrets (.env.example has names only, placeholder values). Production refuses to start with defaults (config.js:69-75). Sends are queued (job table + runDueJobs()) and chunked (100 per fan-out chunk, config.js:50), never a for-await inside a request handler. Token bucket + circuit breaker in front of every email send (guard.js). One mild point off: circuit-breaker and rate-limiter state are in-memory and reset on restart -- documented in README Known limitations. |
| **Total** | **98/100** | |

Killer Tests:
1. READY · 10/10 · tests/kt1.test.js: 10 events fired 20 s apart (200 s, inside a 300 s window), worker advances the clock, asserts exactly 1 delayed digest master + 9 merged jobs + 0 messages while the window is open, then 1 email and 1 in-app after flush. Partial unique index on jobs(subscriber_id, workflow_id, digest_key, digest_value) WHERE status='delayed' (db.js:134-136) enforces no second master at the DB level. Digest window is configurable via DIGEST_WINDOW_MS (config.js:45). Window is DB-persisted, not setTimeout. Verified: 4/4 pass.
2. READY · 10/10 · tests/kt2.test.js: mutes global email via PATCH /inbox/preferences, triggers an event, asserts zero provider calls for that student, asserts delivery_email = 'skipped' and delivery_in_app = 'sent' in the DB, verifies the activity log shows step_skipped for the email step. Preferences resolved server-side at job execution time (subscribers.js:139-152), not hidden in the UI. Critical workflows force all channels on, proven by a separate test case. Verified: 5/5 pass.
3. READY · 10/10 · tests/kt3.test.js: FakeEmailProvider(['fail-500','ok']) drives attempt 1 to fail, asserts job status retrying, confirms provider not called again until 1 s backoff elapses, then succeeds. Same idempotency key on both attempts (pipeline.js:24-25, verified at kt3.test.js:49). Pre-send duplicate check (pipeline.js:355-368) catches the provider-accepted-but-result-not-saved crash scenario. UNIQUE index (subscriber_id, channel, idempotency_key) on messages (db.js:171) is a DB-level guard. Verified: 7/7 pass.

Improvements:
1. Fail-closed inbound webhook signature verification · 10/10 · src/engine/webhooks.js: HMAC-SHA256 body scheme (generic) and timestamp+token scheme (mailgun) implemented. valid->200, invalid/missing->401, unsupported/unconfigured->400, never falls through to trust-by-default. Constant-time comparison via safeEqual(). Every request audited without the signature. tests/webhook.test.js: 9/9 pass verified live.
2. Intelligent Focus Mode · 10/10 · src/engine/focus.js: sessions persist in focus_sessions, held deliveries in held_events, session end triggers buildSummary() which correlates by correlation_value, suppresses facts already in bypassed (critical) alerts or already read, and delivers one catch-up through the normal pipeline (so email mutes and retries still apply). Critical workflows bypass entirely (pipeline.js:445-462). tests/focus.test.js: 8/8 pass verified live.

Flags: none

3 questions for the judges to ask this team in their Defence, aimed at the weakest spots found:

1. Digest window start semantics (pipeline.js:194): The window starts at event.created_at (the event ingest timestamp), not at the time the first fan-out job is processed by the worker. For a 30,000-student broadcast with a 300 s window, fan-out may take several seconds; some students' digest jobs enter enterDigest() while the window is already partially elapsed. How does the team justify this choice, and under what conditions could a student's digest window be effectively shorter than the configured value?

2. In-memory circuit-breaker / rate-limiter reset on restart (guard.js; config.js:57-59): After a crash, the breaker re-opens from closed state. If the provider was down when the server died, the first tick after restart immediately issues sends, potentially hammering a still-degraded provider. Walk us through what would happen to the retry budgets and dead-letter queue in that scenario, and what a production-grade solution would look like.

3. Source code committed before docs/ (git history): Commit e0fde16 (08:37 IST) contains the full engine source code; commit 5d230fe (08:43 IST) adds the docs/ folder. The HACKBACK rules require that code is rebuilt from your own docs, implying docs come first. Please explain the actual build sequence: were the docs written first in a separate working copy and committed later, or was the engine written from memory / the docs themselves?

SCORE core=30 kt=30 imp=20 docs=9 eng=9 total=98
