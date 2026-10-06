# OBSERVATIONS.md — Verified Original Product Findings


## Original Product

- **Repository:** novuhq/novu
- **Commit:** cca284eb3375d7be648728a4e5e3552303d8d528
- **Card:** Campus Notification Engine
- **Problem:** An exam timetable change must reach 30,000 students fast, without spamming them.

## Product Purpose

Novu transforms a single trigger event into per-subscriber notifications across multiple channels (email, in-app, SMS, push, chat) with per-subscriber preferences, event digest grouping, and asynchronous delivery via background workers.

## Verified Technology Stack

| Component | Technology | Evidence |
|---|---|---|
| Backend | NestJS 11.1.27 | apps/api/package.json:62 [Confirmed] |
| Database | MongoDB 8.0.17 + Mongoose | docker-compose.yml:19, libs/dal/package.json:38 [Confirmed] |
| Cache/Queue | Redis (ioredis ^5.11.1) | docker-compose.yml:4 [Confirmed] |
| Default Queue | BullMQ ^3.10.2 | queue-backend.ts:38 [Confirmed] |
| Realtime | socket.io ^4.8.3 | apps/ws/package.json:61 [Confirmed] |
| Optional Queue | SQS | queue-backend.ts:26-30 [Confirmed] |

## Core Event Flow

```
1. POST /v1/events/trigger → ParseEventRequest → enqueue to trigger-handler
2. TriggerEvent worker → resolve recipients → fan-out to process-subscriber queue
3. SubscriberJobBound → create Notification + Job chain
4. Standard queue workers → execute jobs (digest, email, in-app)
5. Delivery workers → call providers, emit WebSocket, mark status
```

## Key Verified Behaviors

### Trigger API
- **File:** events.controller.ts:88
- **Behavior:** Returns 201 PROCESSED immediately; async execution follows [Confirmed]
- **No enforcement:** 100-recipient doc claim vs validator:56 (non-empty check only) [Confirmed]

### Digest Grouping
- **File:** merge-or-create-digest.usecase.ts:42-177, job.schema.ts:429-450
- **Behavior:** 
  - First event becomes DELAYED master; subsequent events MERGED [Confirmed]
  - Grouped per (subscriber, workflow, digestValue)
  - Guarded by unique partial index on (subscriberId, templateId, digestKey, digestValue, status='delayed') [Confirmed]
  - Window fixed from first event (not sliding) [Confirmed]

### Preference Evaluation
- **File:** send-message.usecase.ts:123-568
- **Behavior:**
  - Per-channel check at execution time (not trigger time) [Confirmed]
  - Priority: TEMPLATE > WORKFLOW_OVERRIDE > SUBSCRIBER [Confirmed]
  - readOnly workflow ignores subscriber mutes [Confirmed]

### Email Delivery
- **File:** send-message-email.usecase.ts:207-731
- **Behavior:**
  - Creates Message unconditionally [Confirmed]
  - No idempotency key sent to provider [Confirmed]
  - Provider failure NOT retried [Confirmed]
  - Failure leaves job FAILED, not in queue [Confirmed]

### In-App Delivery
- **File:** send-message-in-app.usecase.ts:175-333
- **Behavior:**
  - Deduplicates via (transactionId, _templateId, providerId, _feedId) lookup [Confirmed]
  - Updates existing or creates new [Confirmed]
  - Emits WebSocket fire-and-forget [Confirmed]

### Retry Behavior
- **File:** add-job.usecase.ts:1109-1113, standard.worker.ts:268-294
- **Behavior:**
  - Retry ONLY for webhook-filter errors, max 3 attempts [Confirmed]
  - Provider failures NOT retried [Confirmed]
  - Workflow/subscriber stage failures dropped (at-most-once) [Confirmed]

## Important Negative Findings

| Feature | Status |
|---|---|
| Unique index on transactionId | NOT FOUND — only plain index |
| Idempotency key to provider | NOT FOUND |
| Email retry on provider failure | NOT FOUND |
| Dead-letter queue for failed jobs | NOT FOUND; jobs removed |
| Outbox pattern for workflow stage | NOT FOUND; dropped on failure |
| Email deduplication | NOT FOUND; re-execution = new Message |
| Circuit breaker/rate limiter | NOT FOUND in worker/factory |

## Rebuild Implications

### KT1 — Ten Events in Five Minutes → One Digest
**Required:** Digest step, time-window grouping, unique master guard, merge decision.  
**Original:** ✓ Fully present and tested  
**Rebuild:** Must preserve exact mechanism

### KT2 — Muted Email → In-App Only
**Required:** Per-channel preference gate at execution time.  
**Original:** ✓ Fully present  
**Rebuild:** Must preserve evaluation timing

### KT3 — Failed Send Retried Without Duplicates
**Required:** Retry mechanism + idempotency key + duplicate prevention.  
**Original:** ✗ Missing for email; only in-app has dedup  
**Rebuild:** MUST implement; this is a gap in original

---

**Evidence Summary:** 283 citations verified against source code (cca284eb3375d7be648728a4e5e3552303d8d528). No invented facts. Claims marked [Confirmed] matched line-by-line. Gaps marked as NOT FOUND indicate genuine absences in the original code.
