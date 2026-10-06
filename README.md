# Campus Notification Engine

A clean-room rebuild for HACKBACK V2. An important campus event (say, an exam timetable change) fans out to many students quickly, without spamming them, respecting their channel preferences, and without losing or duplicating messages.

It was built only from the seven documents in `../docs/`. Where those documents were silent or contradicted each other, the choice is recorded under [Implementation assumptions](#implementation-assumptions).

## What it does

- **Ingest** events over HTTP (`202 Accepted`), de-duplicated by `transactionId` for 24h.
- **Fan out** to explicit subscriber lists, topics, or everyone, in chunks of 100, with progress persisted so a failed fan-out resumes instead of dropping people.
- **Digest**: a workflow's digest step groups events per (subscriber, workflow, digest value) inside a window. The first event is the master, the rest merge into it, and one email plus one in-app message is delivered when the window closes.
- **Preferences** (email / in-app, global or per workflow) are checked when the job runs, not when the event arrives. Critical workflows ignore mutes.
- **Delivery**: email through a provider adapter, in-app messages in a per-user inbox.
- **Retry**: bounded retries with backoff (1s, 5s, 15s, 3 attempts) for transient failures. A retry adds a delivery-attempt row and reuses the same idempotency key. It never creates a new notification or a second message.
- **Fix, fail-closed inbound webhooks**: provider delivery callbacks are only trusted when their signature verifies.
- **Differentiator, Intelligent Focus Mode**: time-boxed quiet periods with critical bypass and a correlated catch-up summary.
- **Observability**: every step writes to an activity log (`GET /admin/activity`).

## Run it

Requires **Node.js 22.5 or newer** (it uses the built-in `node:sqlite`; developed on Node 26). No Redis or MongoDB is needed.

```bash
cd campus-notification-engine
npm install
cp .env.example .env        # optional; defaults work for local use
npm run seed                # demo workflows + student_001..student_005
npm start                   # http://localhost:3000
```

Open `http://localhost:3000`, enter the API key (default `campus-admin-api-key-change-in-production`) and a subscriber id such as `student_001`. The "Send / Activity" tab sends a test event to the signed-in student.

The server refuses to start with `NODE_ENV=production` while the placeholder `API_KEY` / `JWT_SECRET` are in use.

### Tests, lint, build

```bash
npm test            # all suites (58 tests, about 15 seconds)
npm run test:kt1    # Killer Test 1: ten events -> one digest
npm run test:kt2    # Killer Test 2: email muted -> in-app only
npm run test:kt3    # Killer Test 3: failed send -> retry -> no duplicate
npm run test:webhook
npm run test:focus
npm run lint        # eslint
npm run build       # there is no compile step; this parses every source file
```

The tests drive the real engine, a real SQLite database and the real HTTP server. Only two things are substituted: the **clock** (so a five-minute digest window takes microseconds) and the **email provider** (a scripted fake that can fail, and can behave like a provider that honours idempotency keys or like one that does not).

## Architecture

```
POST /events/trigger ──> events (persisted, 202)
                           │  worker tick (every WORKER_TICK_MS, or engine.tick() in tests)
                           ▼
                 fan-out (chunks of 100, resumable: event_recipients)
                           ▼
        notifications  (UNIQUE per event + subscriber)  +  job chain
                           ▼
   digest ──> email ──> in-app          (jobs: queued / delayed / merged / retrying / ...)
     │          │          │
     │          │          └─ messages (in-app inbox)
     │          └─ prefs gate ─ focus gate ─ provider.send(idempotencyKey) ─ delivery_attempts + messages
     └─ one DELAYED master per (subscriber, workflow, digest value): partial unique index
```

| Path | Responsibility |
|---|---|
| `src/db.js` | SQLite schema, transactions, all uniqueness constraints |
| `src/engine/ingest.js` | validation, idempotent accept, bulk, broadcast, resumable fan-out |
| `src/engine/pipeline.js` | notification + job chain, digest merge, claim/execute, retry, cancel |
| `src/engine/subscribers.js` | subscribers, topics, preference resolution |
| `src/engine/focus.js` | focus sessions, held events, correlation, catch-up summary |
| `src/engine/webhooks.js` | inbound webhook verification and application |
| `src/engine/queries.js` | inbox and admin read models |
| `src/http/` | Express routes, API-key auth, JWT auth, rate limiter |
| `src/providers/email.js` | provider contract, console provider, optional SMTP adapter |

Identities are kept apart on purpose:

| Concept | Where | Uniqueness |
|---|---|---|
| Event | `events` | `transaction_id` |
| Notification | `notifications` | `(event_id, subscriber_id)` |
| Delivery attempt | `delivery_attempts` | `(job_id, attempt_no)` |
| Provider result | `messages.provider_message_id` / `provider_status` | message `(subscriber_id, channel, idempotency_key)` |

## Killer Tests

| Test | Result | Where |
|---|---|---|
| KT1: 10 events in 5 minutes become 1 digest | passes | `tests/kt1.test.js` |
| KT2: email muted, so in-app only | passes | `tests/kt2.test.js` |
| KT3: failed send, retried, no duplicates | passes | `tests/kt3.test.js` |

KT1 sends ten events 20 seconds apart and checks that nothing is delivered while the window is open. After it closes it checks one provider call, one email message, one in-app message, all ten events inside the content, and that the notifications are `sent: 1, digested: 9`. A separate test shows the database itself rejecting a second delayed master.

KT2 checks both sides: the muted user has zero email attempts and one in-app message, and the log shows `step_skipped` for email.

KT3 checks that attempt 1 fails and is scheduled for retry, that the retry waits for the backoff, and that attempt 2 succeeds with the same idempotency key. It also checks that notification and event counts do not change, and that the log reads `email_failed(1) -> retry_scheduled -> email_sent(2)`. Further tests cover a provider that accepted the mail but returned an error, a provider that cannot de-duplicate, retry exhaustion, permanent errors, and re-running an already delivered job.

## Fix: fail-closed webhook signature verification

`POST /webhooks/:provider` (inbound provider callbacks, not the producer API).

| Situation | Response | Effect |
|---|---|---|
| valid signature | 200 | applied (`provider_status` set; a bounce marks the message `delivery_failed`) |
| invalid signature, or stale timestamp | 401 | nothing applied |
| signature missing | 401 | nothing applied |
| no verifier exists for the provider (`sendgrid`, unknown names) | 400 | nothing applied |
| verifier exists but no secret configured | 400 | nothing applied |
| unsupported provider **and** `WEBHOOK_ALLOW_UNVERIFIED_<PROVIDER>=true` | 202 | recorded as `unverified`, still never applied |

Providers: `generic` (header `x-webhook-signature: sha256=<hex>`, HMAC-SHA256 over the raw body) and `mailgun` (HMAC-SHA256 of `timestamp + token` from the body, with a timestamp tolerance). Comparison is constant-time. Every request, rejected ones included, is audited in `webhook_events` without the signature or secret.

What this does **not** give you: no replay protection for the `generic` scheme, and no verifier for ECDSA-signed providers such as real SendGrid (those stay rejected). The `mailgun` scheme follows the documented timestamp-plus-token idea but has not been tested against real Mailgun traffic.

## Differentiator: Intelligent Focus Mode

`POST /inbox/focus-mode/start {"duration":"2h"}` (also `"30m"` or a number of minutes, capped by `FOCUS_MODE_MAX_HOURS`).

- While active, a **non-critical** delivery is **held** (recorded in `held_events`, job `deferred`). Muted channels are still skipped first.
- A **critical** one is delivered at once and remembered. Critical means: the workflow is `critical`, the event was sent with `"priority":"critical"`, or a workflow rule matches, for example `{"field":"minutesUntilExam","op":"lt","value":30}`.
- When the session ends (timer or `POST /inbox/focus-mode/end`), held events are grouped by the workflow's `correlationKey` (for example `exam`), repeats are dropped, and what changed is computed (`room: A201 -> H123`). A held event is also dropped if a critical delivery during the session, or a message the user marked seen during the session, already stated the same facts.
- One catch-up notification is created through the normal pipeline, so email mutes and retries still apply. `GET /inbox/focus-mode/summary` returns the structured version, including how many events were suppressed.

This is not the digest: a digest lists every event, while Focus Mode reports what changed, what was already delivered, and what is still outstanding.

## API

The routes in `docs/API.md` are implemented. The same transactionId on a repeat submission returns `202` with the first response and `"duplicate": true`. Additions beyond the documented contract:

| Route | Why |
|---|---|
| `PUT /admin/workflows/:identifier`, `GET /admin/workflows` | workflows must be defined somehow (steps, digest window, critical rules) |
| `PUT /admin/subscribers/:subscriberId` | create subscribers with an email address |
| `PUT /admin/topics/:topic/subscribers` | topic membership for topic fan-out |
| `PATCH /inbox/notifications/:messageId/seen` | read state; also feeds Focus Mode suppression |
| `POST /webhooks/:provider` | the Fix |
| `POST /inbox/focus-mode/start`, `POST /inbox/focus-mode/end`, `GET /inbox/focus-mode/status`, `GET /inbox/focus-mode/summary` | the Differentiator |

Auth: producer and admin routes need `Authorization: Bearer <API_KEY>`. Inbox routes need the subscriber JWT, and the subscriber is taken only from the verified token.

## Implementation assumptions

1. **Storage and queue.** `docs/ARCHITECTURE.md` says "Redis + BullMQ or similar" and MongoDB. Neither is installed here, so persistence is SQLite (`node:sqlite`) and the queue is the `jobs` table polled by a worker. The Mongo partial unique index maps to a SQLite partial unique index. Single-process only: the claim logic is multi-worker safe in principle (conditional `UPDATE`), but this was not tested with several processes.
2. **No WebSocket gateway.** In-app delivery writes the message and emits on an in-process event bus (`engine.ctx.bus`). The UI polls every 3 seconds.
3. **Duplicate transactionId.** `API.md` says both "409" and "202 with the cached response". 202 with the cached response is implemented.
4. **`POST /inbox/session` is not public by default.** `API.md` marks it public, which lets anyone mint a session for any subscriber. The default is to require the API key. `INBOX_SESSION_AUTH=public` restores the documented behaviour.
5. **In-app retries.** The docs give in-app one attempt. In-app jobs get the same attempt budget as email, because the upsert makes retry harmless and a transient preference-lookup or database error should not lose the message.
6. **Failed email proceeds.** As in FR5, an email that fails permanently or exhausts its attempts is marked failed and the chain continues to the next step.
7. **Digest window** starts at the first event's submission time. A digest step is only allowed as the first step of a workflow.
8. **Cancel** removes the pending jobs of a transaction. If other transactions are merged into the same digest master, the master survives for them and only the cancelled event's content is dropped.
9. **Expired transactionId reuse.** After 24h the old event row is renamed (`#expired#<id>`) so the id can be reused.
10. **Critical vs. mutes.** A critical workflow ignores mutes and Focus Mode. A critical event (`priority` or rule) bypasses Focus Mode but still respects mutes.
11. **Rate limit** is a per-API-key fixed window held in memory (default 100 events per minute).
12. **Reserved workflow** `__focus_summary__` carries the catch-up summary and cannot be triggered or edited through the API.

## Known limitations

- Not load-tested. The 30,000-recipient claim is a design property (chunked, resumable, DB-backed), not a measured result. The largest test fans out to 250 recipients.
- The SMTP adapter (`SMTP_HOST`) needs `npm install nodemailer` first and has never been run against a real mail server. The default console provider does not send mail.
- Email idempotency depends on the provider. With a provider that ignores the key, a failure that happens after the provider accepted the message can still send twice. The engine's own `messages` unique constraint protects its records, not the provider.
- Webhook limits: see above.
- Preference changes apply to jobs that have not run yet, by design, so a mute that arrives between trigger and delivery is honoured.
- No type checker is configured (plain JavaScript); `npm run build` only verifies that files parse.
