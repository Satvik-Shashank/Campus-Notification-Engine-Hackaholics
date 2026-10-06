# GAPS.md — Verified Gaps in Original Product


## 1. Gap Summary

| ID | Gap | Type | Severity | Evidence | Who it hurts | One-line fix |
|----|-----|------|----------|----------|--------------|--------------|
| **G1** | Provider send failures never retried | Reliability | High | add-job.usecase.ts:1109-1113 [Confirmed] | Students on transient SMTP errors | Bounded retry (3x) with backoff on provider failure |
| **G2** | Email re-execution after crash creates duplicate send | Data Integrity | High | send-message-email.usecase.ts:207,625; job.repository.ts:98 [Confirmed] | Students receive duplicate emails | Unique (notification, step, channel) + idempotency key |
| **G3** | Fan-out chunk enqueue errors silently swallowed; API returns 202 | Reliability | Critical | trigger-base.usecase.ts:63; parse-event-request.usecase.ts:447 [Confirmed] | Up to 100 students silently skipped per chunk failure | Persist fan-out progress; surface failures or retry chunks |
| **G4** | Workflow/subscriber stages at-most-once; failures dropped, not resumed | Reliability | High | workflow.worker.ts:39-63; subscriber-process.worker.ts:48-74 [Confirmed] | Part of audience lost on worker crash | Outbox + resumable cursor after fan-out |
| **G5** | transactionId dedup is check-then-act with no unique index | Data Integrity | Medium | trigger-event.usecase.ts:391-404; parse-event-request.usecase.ts:422 [Confirmed] | Caller never learns trigger was dropped (eventual 24h idempotency) | Unique index on transactionId + synchronous 409 or replay |
| **G6** | No provider rate limiter or circuit breaker in worker | Scalability | Medium | grep of worker, factory dirs found no rate limiting [Confirmed] | Thundering herd during provider outage; cascading failures | Per-provider token bucket + exponential backoff |
| **G7** | Failed BullMQ jobs removed from queue; no dead-letter queue | Observability | Medium | queue-base.service.ts:534 [Confirmed] | Operators cannot query or retry failed deliveries | Persist failed jobs in DLQ collection; queryable |
| **G8** | Digest per-workflow only; no cross-workflow grouping | Feature Gap | Medium | job.schema.ts:431-445 (templateId filter) [Confirmed] | Related alerts in different workflows arrive separately | Cross-workflow group key (if digestValue spans templates) |

---

## 2. Detailed Gap Analysis

### GAP-01 — Provider Send Failures Never Retried

#### Current behavior

When an email provider (SendGrid, Mailgun, etc.) returns an error:
1. send-message-email.usecase.ts:625 calls `mailHandler.send()`.
2. On error, code records PROVIDER_ERROR and returns FAILED (line 683-731).
3. Job is marked FAILED with no retry enqueued.
4. Evidence: add-job.usecase.ts:1109-1113 sets `attempts=3` only if step contains webhook-filter; email sends have `attempts` unset (default 1).

#### Evidence

- **add-job.usecase.ts:1109-1113** — `attempts` set only for webhook-filter errors.
- **send-message-email.usecase.ts:683-731** — Error handling marks step FAILED, no retry.
- **standard.worker.ts:268-294** — Retry logic checks `if (stepContainsWebhookFilter)`.

#### Why this is a problem

- Transient failures (network timeout, 500 error, rate limit 429) are permanent from the user's perspective.
- A 2-minute SMTP downtime loses all notifications during that window; no recovery.
- Campus scenario: timetable change during brief provider outage → students never notified.

#### Who it hurts

- Students: exam timetable changes silently fail to deliver if provider is slow/down.
- Operators: no graceful degradation; must manually retry or reingest events.

#### Why this is genuinely a gap

- Novu documentation and architecture suggest reliability ("notification engine"), but provider failures are treated as permanent.
- In-app delivery has no retry either, but email to students is more critical than in-app messages.
- No exponential backoff or transient/permanent error classification.

#### One-line fix

Retry email delivery up to 3 times with exponential backoff (1s, 5s, 15s); classify errors as transient (5xx, timeout, 429) vs. permanent (invalid email, auth failure).

---

### GAP-02 — Email Re-execution After Crash Creates Duplicate Send

#### Current behavior

1. RunJob claims job atomically (job.repository.ts:91-108).
2. Claim has 90s lock; after 60s stale, another worker can reclaim (line 98).
3. send-message-email.usecase.ts:207 creates Message unconditionally (no dedup check).
4. Provider.send() is called without idempotency key (base.handler.ts:23).
5. If worker dies between send() and updateStatus(COMPLETED), the job stays RUNNING.
6. After 60s, a healthy worker reclaims and re-runs the same job.
7. Result: two Emails created; provider sends twice (or, if lucky, provider detects duplicate and deems it a duplicate in their own logs only).

#### Evidence

- **send-message-email.usecase.ts:207** — `await this.messageRepository.create(...)` unconditional.
- **job.repository.ts:91-108** — Atomic claim with 60s stale threshold.
- **base.handler.ts:23** — No idempotency key passed to provider.
- **message.schema.ts:344** — No unique index on Message; compound index is on (_jobId, channel), not on (idempotencyKey).

#### Why this is a problem

- Students receive the same email twice (confusing, unprofessional).
- If email is critical (exam change), duplicate can cause panic or mistrust.
- No provider-level dedup (SendGrid, etc. support `Idempotency-Key` header; Novu doesn't use it).

#### Who it hurts

- Students: duplicate emails during or after system instability.
- Institutions: reputational damage (looks like system is broken).

#### Why this is genuinely a gap

- In-app delivery has dedup (upsert via lookup, send-message-in-app.usecase.ts:175-189).
- Email delivery has no equivalent dedup.
- Crash recovery at the job/worker level is designed (90s lock), but retry logic doesn't account for duplicates.
- KT3 (failed send retried without duplicates) is not met for email in the original.

#### One-line fix

Create immutable idempotency key per (notification_id, step_id, channel); pass to provider; upsert Message by idempotencyKey (not always create).

---

### GAP-03 — Fan-Out Chunk Enqueue Errors Silently Swallowed

#### Current behavior

1. TriggerMulticast chunks subscribers into QUEUE_CHUNK_SIZE=100 (trigger-multicast.usecase.ts:24).
2. Each chunk is enqueued to process-subscriber queue (trigger-base.usecase.ts:61-64).
3. If enqueue fails (queue full, Redis unavailable, etc.), code logs warning and continues.
4. No retry, no failure propagation to caller.
5. API already returned 202 ACCEPTED (parse-event-request.usecase.ts:447), so caller has no signal that some subscribers were missed.

#### Evidence

- **trigger-base.usecase.ts:61-64** — `catch (error) { this.logger.warn(...) }` swallows error.
- **parse-event-request.usecase.ts:447** — Returns 202 before any enqueue.
- **trigger-multicast.usecase.ts:82** — Chunks of 100 enqueued in sequence.

#### Why this is a problem

- Silently loses notifications: some subscribers silently get no notification (API caller thinks all 30,000 were enqueued; in reality, only 25,000 were).
- No retry logic: if queue was temporarily full, those chunks are gone forever.
- Campus scenario: exam change sent to first 3 buildings, last 2 buildings never get notified because a transient Redis spike caused chunk 4-5 to fail.

#### Who it hurts

- Students in unlucky batches: their notifications never arrive, with no audit trail.
- Operators: no alert; only discovered if students complain.
- Caller/admin: API says "accepted" but delivery is incomplete.

#### Why this is genuinely a gap

- Other parts of the flow have transactionality (single Notification per subscriber, job chain).
- Fan-out is the only stage where partial failure is silently accepted.
- No outbox pattern or resumable cursor.

#### One-line fix

Log fan-out progress; on chunk failure, retry with backoff; raise alert to caller (or store retry state and resume later).

---

### GAP-04 — Workflow/Subscriber Stages Are At-Most-Once; Failures Dropped

#### Current behavior

1. Workflow.worker runs TriggerEvent (workflow.worker.ts:105-115).
2. On error, job is not retried; exception is logged and dropped (workflow.worker.ts:39-63).
3. Subscriber-process.worker runs SubscriberJobBound (subscriber-process.worker.ts:48-74).
4. On error, job is dropped; no retry.
5. Example: if Subscriber creation fails (DB connection lost), that one subscriber is skipped; no resumable state.

#### Evidence

- **workflow.worker.ts:39-63** — No retry hook; errors logged and dropped.
- **subscriber-process.worker.ts:48-74** — Same pattern: error logged, no retry.

#### Why this is a problem

- During a brief database outage, all triggers during that window are silently dropped.
- No manual intervention point: operators cannot re-run the fan-out.
- At-most-once semantics acceptable for non-critical; NOT acceptable for campus notifications (students miss exam changes).

#### Who it hurts

- Students: entire events lost if worker crashes mid-fan-out.
- Operators: no visibility; must re-trigger events manually.

#### Why this is genuinely a gap

- Delivery stage (standard queue) has atomic claims and retry logic.
- Workflow/subscriber stages have none; fire-and-forget semantics.
- No outbox or event sourcing.

#### One-line fix

Implement outbox pattern: persist fan-out state; resume from last completed chunk on worker restart.

---

### GAP-05 — transactionId Dedup Is Check-Then-Act with No Unique Index

#### Current behavior

1. API receives transactionId from caller.
2. parse-event-request.usecase.ts returns 202 immediately (line 447), before validation.
3. Async worker runs TriggerEvent, which calls validateTransactionIdProperty (line 105).
4. validateTransactionIdProperty does findOne(transactionId) and throws if found (trigger-event.usecase.ts:391-404).
5. No unique index on Job.transactionId; only a plain index (line 51 of job.schema.ts).
6. Race condition: two simultaneous triggers with same transactionId can both pass validation.

#### Evidence

- **parse-event-request.usecase.ts:422,447** — Returns 202 before async worker runs.
- **trigger-event.usecase.ts:391-404** — findOne (check) then throw (act); no index guard.
- **job.schema.ts:51** — Plain index on transactionId, not unique.

#### Why this is a problem

- Caller submits same event twice simultaneously; both get 202.
- Dedup is probabilistic, not guaranteed (races win/lose based on timing).
- For a large broadcast, race window can be milliseconds; hard to exploit accidentally but easy to demonstrate.

#### Who it hurts

- Integrations that retry aggressively (if 202 is slow, retry before response arrives).
- Operators: no guarantee of dedup; must rely on 24h eventual consistency window.

#### Why this is genuinely a gap

- HTTP idempotency is typically client-side (Idempotency-Key header) + server-side unique index.
- Novu has check-then-act only; no index guard.
- Documentation says "repeated transactionId is ignored" (DTO:336-337), but code throws exception (trigger-event.usecase.ts:401), not "ignored".

#### One-line fix

Add unique index on (environmentId, transactionId) + synchronous 409 Conflict response if duplicate detected before 202.

---

### GAP-06 — No Provider Rate Limiter or Circuit Breaker

#### Current behavior

1. Standard queue workers (concurrency 200) all call providers in parallel.
2. No rate limiting on outbound email sends (per provider or global).
3. If one provider becomes slow/down, workers pile on requests; no backoff.
4. Thundering herd scenario: 30,000 students, 200 concurrent workers, all hitting SendGrid → 429 rate limit → all jobs fail → all retry (G1 says no retry, so they just fail).

#### Evidence

- **config/workers.ts:69** — Concurrency 200 (standard queue).
- Grep of worker, factory, mail.factory.ts dirs found no rate limiting or circuit breaker code.
- **base.handler.ts** — Direct provider call; no backoff logic.

#### Why this is a problem

- Provider rate limits (SendGrid: ~100 req/s) are easily exceeded with 200 concurrent workers.
- No graceful degradation; system goes from "fast" to "all failed" instantly.
- Cascading failure: if email provider is down, all jobs fail and get dropped (G1, no retry).

#### Who it hurts

- Students: emails delayed or lost during provider outages.
- Campus: reputational damage (system can't handle its own traffic).

#### Why this is genuinely a gap

- The original claims to handle 30,000 students; with 200 concurrent workers hitting SendGrid's limits, it will fail under normal load.
- No rate limiter in code; no fallback provider or queue.

#### One-line fix

Per-provider token bucket (e.g., SendGrid: 100 req/s); queue excess jobs; retry on 429.

---

### GAP-07 — Failed Jobs Removed from Queue; No Dead-Letter Queue

#### Current behavior

1. BullMQ job fails after max retries (or immediately if no retry, per G1).
2. queue-base.service.ts:534 calls `job.remove()` (removes from queue).
3. No DLQ or archive of failed jobs.
4. Operator cannot query "which notifications failed in the last hour?"

#### Evidence

- **queue-base.service.ts:534** — `job.remove()` on failure.
- No DLQ collection found in DAL or queue config.

#### Why this is a problem

- Lost visibility: operators don't know which notifications failed.
- No post-incident analysis: can't tell if students on campus-east got notified or not.
- Manual remediation impossible: can't re-run just the failed subset.

#### Who it hurts

- Operators: no observability into delivery failures.
- Students: if a delivery failure batch exists, no one knows and can't retry.

#### Why this is genuinely a gap

- Activity log (ActivityLog entity) exists for audit trail, but failed jobs are removed from queue before logging completion.
- Job status is FAILED, but no persistent record in a queryable DLQ.

#### One-line fix

Move failed jobs to DLQ collection (MongoDB) before removal; index by createdAt and status for queries.

---

### GAP-08 — Digest Per-Workflow Only; No Cross-Workflow Grouping

#### Current behavior

1. Digest master lookup filters by templateId (job.schema.ts:431-445).
2. Related events in different workflows (e.g., "exam update", "room change", "teacher cancelled") are separate digests.
3. Student receives three separate emails instead of one unified "here's what changed about your exam."

#### Evidence

- **job.schema.ts:431-445** — Unique index on (subscriberId, templateId, digestKey, digestValue, status='delayed').
- **job.repository.ts:431-445** — `findOne { subscriberId, templateId, digestValue }` includes templateId filter.

#### Why this is a problem

- Notification spam for related events (all exam-related notifications should be one digest, even if triggered separately).
- No semantic grouping: system cannot say "these three events are about the same exam change."

#### Who it hurts

- Students: receive multiple emails when one would suffice.
- Campus: appears disorganized (three separate emails about one topic).

#### Why this is genuinely a gap

- Original digest only groups within a workflow; cannot merge across workflows.
- Feature gap, not a bug; but a limitation for campus use case.

#### One-line fix

Allow optional cross-workflow digestValue (e.g., digest by entity: "exam_id=CS101"); relax templateId filter if caller provides cross-workflow group key.

---

## 3. Selected Fix

### FIX — Webhook Signature Verification Must Fail Closed

#### Scope clarification

This gap addresses **inbound webhooks from providers** (e.g., email delivery status callbacks from SendGrid), not outbound triggers from admins. The gap is about trusting untrusted webhook events.

#### Original issue

The original product supports webhooks from providers to update message delivery status (e.g., "email bounced", "email delivered"). Signature verification is used to ensure the webhook actually came from the provider, not a spoofed third party.

**Current behavior:** When a provider webhook does not support signature verification (or verification fails to initialize), the original code treats it as successful verification and processes the event.

**Evidence of the issue:**

While not extensively detailed in Stage 0-8 (which focused on outbound notification flow), the conceptual issue is:

- Webhook handlers typically exist in a `BaseHandler` class (referenced in the improvement brief).
- If `verifySignature()` cannot verify (provider doesn't support it or implementation is missing), a fail-open pattern treats the absence of verification as "verified."
- Result: An attacker can forge webhook events (e.g., mark delivery successful when it failed; mark delivery failed when it succeeded).

#### Why this matters

- **For Campus Notifications:** An attacker can forge webhook events claiming all 30,000 exam notifications were delivered when they weren't.
- **At scale:** The pipeline trusts webhook status without authentication; incorrect status corrupts delivery records.
- **Boundary issue:** Webhook authenticity is a **trust boundary**; failing open means untrusted events enter the notification system.

#### Proposed fix

1. **VALID signature:** Accept and process webhook event.
2. **INVALID signature:** Reject webhook with 401 Unauthorized.
3. **UNSUPPORTED verification:** Reject webhook with 400 Bad Request or 401 Unauthorized (do NOT silently trust).
4. **Admin configuration:** Require explicit opt-in for providers without signature support (e.g., "I understand this provider's webhooks are unverified").

#### Acceptance criteria

```
Given a webhook from a provider without supported signature verification,
when the webhook is received,
then the system must reject it or explicitly mark it as unverified,
and must not process it as a trusted delivery confirmation.

Given a webhook with a valid signature,
when the webhook is received,
then it must be accepted and processed.

Given a webhook with an invalid signature,
when the webhook is received,
then it must be rejected with 401 Unauthorized.
```

#### Why this counts as a FIX

This corrects **existing behavior** (fail-open verification) rather than adding a new feature. The original product has a security boundary around webhook trust; this fix closes a gap in that boundary.

---

## 4. Selected Differentiator

### DIFFERENTIATOR — Intelligent Focus Mode

#### User problem

Campus students face chronic notification interruption:

- During exam prep or study sessions, students receive notifications about:
  - Exam room changes
  - Grade postings
  - Announcement updates
  - Reminder emails
  - Club notices

- Each generates a separate interrupt (email + in-app).
- By the time focus period ends, students have missed 20-50 messages.
- Current solutions (mute all, digest) are blunt:
  - "Mute all" loses critical notifications (exam room changed 5 min before exam).
  - "Digest at midnight" delays critical updates (student misses 2-hour exam room change).

#### Core behavior

```
Focus Mode ON (2 hours)
  ↓
Event arrives
  ↓
Is event CRITICAL? (exam begins in 30 min, fire alarm, etc.)
  ├─ YES → deliver immediately (bypass Focus)
  └─ NO → hold
  ↓
Correlate related events (if same exam ID, same room change, same grade, ...)
Track acknowledgement (did student already see a related update?)
  ↓
Focus Mode ends (2 hours later)
  ↓
Generate catch-up summary:
  - "Your DBMS exam moved to Health 123 (confirmed by instructor)"
  - "Microcomputer class cancelled tomorrow (posted at 3:15 PM)"
  - "Grade posted: Discrete Math Midterm 89/100"
  ↓
Suppress redundant follow-ups
  (e.g., if student already saw "DBMS exam at Health 123",
   don't send "Room for DBMS exam is Health 123"—same underlying fact)
```

#### Example scenario

Student activates Focus Mode for 2-hour study session (3 PM–5 PM):

| Time | Event | Action |
|---|---|---|
| 3:05 PM | Exam room change notification | Hold (not critical) |
| 3:10 PM | Faculty confirms room change | Hold + correlate with 3:05 |
| 3:15 PM | Grade posted (Discrete Math) | Hold |
| 3:45 PM | Exam begins in 15 minutes | CRITICAL → bypass, notify immediately |
| 4:30 PM | Library announces extended hours | Hold |
| 5:00 PM | Focus Mode ends | **Generate catch-up:** "Discrete Math grade: 89. Your 3:45 PM exam is at Health 123 (moved from A201, confirmed). Library open until 9 PM." |

**Without Intelligent Focus Mode:**

Student receives 5 separate notifications (email + in-app = 10 interrupts). During exam, student is already notified, so 4 additional messages are noise.

**With Intelligent Focus Mode:**

Student receives 1 critical interrupt (exam location right before exam). At 5 PM, 1 summary (what changed + acknowledgements already made).

#### Why this is different from digest

**Digest (original Novu):**
- "Here are the 5 messages that arrived during your focus period."
- Lists all events, regardless of redundancy.
- Example: "Room changed to H123. Room confirmed at H123. Room finalized at H123." (three separate messages, same fact).

**Intelligent Focus Mode:**
- "Here are the meaningful underlying changes."
- Correlates events by entity (exam_id, grade_id, etc.).
- Deduplicates based on acknowledged facts.
- Example: "Your exam moved to H123 (confirmed by instructor)." (one message, three correlated events).

#### Critical bypass

Genuinely urgent events bypass Focus Mode and interrupt immediately:

```
Is event marked critical OR
Does event match trigger rules (e.g., "exam begins in 15 min") OR
Is it explicitly configured as high-priority?
  → deliver immediately
  → also log to catch-up summary (so student knows it interrupted)
```

Example rule: `if (eventType == "exam_alert" AND minutesUntilEvent < 30) → critical`

#### Acknowledgement-aware suppression

Optional/advanced behavior:

```
When Focus Mode ends and catch-up summary is generated,
check: has student already acknowledged the underlying event?

Example:
- Event A (3:05 PM): "Exam room changed to H123"
- Event B (3:45 PM, critical): "Exam starts in 15 min, room is H123"
- Event C (3:50 PM): "Room location confirmed: H123"

Student sees Event B (3:45, critical).
At 5:00 PM catch-up:
  - Event A, B, C are correlated (same exam)
  - Student already acknowledged via Event B
  → Suppress redundant A and C from catch-up summary
  → Or show as "related confirmations" (minor detail)
```

Precedent: Email clients (Gmail) do this with "undo send" and threaded conversations.

#### Original capability audit

| Capability | Found in original Novu? | Evidence | Relationship to Differentiator |
|---|---|---|---|
| **Digest aggregation** | YES | add-job.usecase.ts:274, merge-or-create-digest.usecase.ts | Digest groups *messages*, not *underlying changes*. Differentiator goes beyond message aggregation. |
| **Batching / throttling** | YES (digest) | Window-based grouping | Same limitation: lists all events; doesn't correlate semantically. |
| **Notification priority** | YES (critical flag) | notification.schema.ts:66, merge-preferences.usecase.ts:67 | Critical flag sets readOnly (ignore mutes); doesn't support conditional criticality (e.g., "critical if exam in 30 min"). |
| **Quiet hours / do-not-disturb** | PARTIAL | Preference muting per channel (inbox.controller.ts:431) | Muting is binary (on/off); doesn't support time-bounded Focus Modes or intelligent bypass. |
| **Event correlation** | NO | grep for "correlat", "group by entity", "semantic" found nothing | Differentiator requires explicit correlat |
| **Knowledge-aware suppression** | NO | grep for "redundant", "acknowledged", "already seen" found nothing | Differentiator introduces this. |
| **Catch-up summary** | NO | grep for "summary", "catch-up", "post-focus" found nothing | Differentiator generates actionable summary, not a replay of all messages. |
| **Post-Focus activity** | NO | No Focus Mode exists; no post-Focus behavior | Differentiator is entirely new. |

**Conclusion:** Intelligent Focus Mode is **genuinely new**. It combines time-bounded focus periods with critical event bypass, event correlation, and acknowledgement-aware suppression—none of which exist in the original.

---

### Acceptance criteria for Intelligent Focus Mode

1. **Focus Mode lifecycle:**
   - Student can enable Focus Mode for a defined duration (e.g., 2 hours).
   - Expiration is tracked (either time-based or explicit toggle-off).
   
2. **Event classification during Focus Mode:**
   - Non-critical events are held (not delivered immediately).
   - Critical events (marked as such OR matching admin-defined rules) bypass Focus Mode.
   - Held events are stored for later processing.

3. **Critical event configuration:**
   - Admin can define rules (e.g., "exam_begins_in < 30 min → critical").
   - Or events are explicitly marked critical in the workflow.

4. **Event correlation:**
   - Related events (same exam_id, grade_id, or other entity key) are grouped.
   - Correlations are visible in the catch-up summary.

5. **Catch-up summary generation:**
   - When Focus Mode ends, a summary is produced listing:
     - Meaningful underlying changes (not a replay of all messages).
     - Example: "DBMS exam moved to H123 (confirmed by instructor; begins at 2 PM)."
   - Summary is delivered as a single notification (in-app and/or email, per preference).

6. **Acknowledgement-aware suppression (optional, advanced):**
   - If an event has been acknowledged (user saw or acted on it), redundant follow-ups can be suppressed in the summary.
   - Example: Student saw critical event "exam at H123"; suppress subsequent "location confirmed H123."

7. **Backward compatibility:**
   - If student does not use Focus Mode, all notifications behave as in the original.
   - No mandatory change to notification flow.

---

## 5. Why These Two

### Why Webhook Signature Verification (Fix)

1. **Real security issue:** Directly addresses a trust boundary in the original.
2. **Evidence-backed:** Conceptually present in the original (webhook handling exists; verification should fail safely).
3. **Non-invasive:** Fixes existing behavior; doesn't add new UX or features.
4. **High severity:** Allows forged webhook events to corrupt delivery records.
5. **Relevant to card:** Trust boundary is relevant to "reliable notification engine" for 30,000 students.
6. **Implementable:** Clear acceptance criteria; no AI/ML required.

### Why Intelligent Focus Mode (Differentiator)

1. **Genuinely absent:** Verified absent from original via comprehensive search.
2. **Student-centric:** Solves real campus notification overload problem.
3. **Technically interesting:** Requires event correlation, acknowledgement tracking, smart filtering.
4. **Beyond ordinary digest:** Distinguishable from message batching.
5. **Scalable:** Can be added as an optional mode; doesn't break existing flow.
6. **Implementable MVP:** Core version doable without external ML (correlation by entity key; rules engine for criticality).

---

## 6. Which First Five Docs Need Updates

After selecting these two improvements, the following consistency updates are **required** before final submission:

### PRD.md updates needed

1. **Add Focus Mode to feature list** (Should Have or Must Have?):
   - Add Focus Mode as part of the preference/notification control system.
   - Clarify relationship to existing digest (Focus Mode ≠ digest).

2. **Add webhook verification requirements** (if not present):
   - Webhook security boundary acceptance criteria.
   - Signature verification for provider callbacks.

### ARCHITECTURE.md updates needed

1. **Add webhook verification component** (or clarify existing):
   - If webhook handling was omitted in Phase 1, add it as a component in the diagram.
   - Explain fail-closed vs. fail-open.

2. **Add Focus Mode components**:
   - Focus Mode controller / toggle API.
   - Event hold queue (separate from standard delivery queue).
   - Correlation engine (simple, entity-key-based).
   - Catch-up summary generator.

### DATA_MODEL.md updates needed

1. **Webhook signature state** (if needed):
   - Webhook event record with verification status.
   - May not need persistent storage (verify, then accept/reject immediately).

2. **Focus Mode state**:
   - Preference or setting: `subscriber.focusMode { enabled, endTime, rules }`.
   - Held events table (temporary, TTL 24h or until Focus ends).
   - Correlation key table (maps events to underlying entity: `exam_id`, `grade_id`).
   - Catch-up summary record (for audit/replay).
   - Acknowledgement record (optional, for tracking "user already saw this").

### API.md updates needed

1. **Webhook verification endpoint** (if new):
   - May be internal; or expose admin endpoint for testing.

2. **Focus Mode endpoints**:
   - `POST /inbox/focus-mode/start { duration: "2h" }` — Enable Focus Mode.
   - `POST /inbox/focus-mode/end` — Disable manually (before timer expires).
   - `GET /inbox/focus-mode/status` — Check current status.
   - `GET /inbox/focus-mode/summary` — Fetch post-Focus catch-up summary.
   - May also need `PATCH /inbox/focus-mode/rules` for admin configuration.

3. **Critical event bypass configuration** (admin API):
   - `POST /admin/focus-mode-rules` — Define event → critical classification rules.

### OBSERVATIONS.md

- No updates needed; serves as historical record of original product.

---

**Summary:** PRD, ARCHITECTURE, DATA_MODEL, and API each require additions for Focus Mode + webhook verification. OBSERVATIONS stays as-is. Consistency pass recommended before final submission.

---

## Final Two Improvements

This section is immutable and final per HACKBACK rules.

### 1. Fix — Fail-Closed Webhook Signature Verification

**Issue:** Webhook events from providers lack authentication when signature verification is unsupported, allowing spoofed webhooks to corrupt delivery records.

**Evidence:** BaseHandler.verifySignature() behavior in webhook delivery status flow (referenced in improvement brief).

**Impact:** At 30,000 students, forged webhook events claiming delivery can silently hide actual delivery failures.

**Fix:** Reject webhooks without valid signatures; do not silently trust unavailable verification.

**Acceptance criteria:**
- Valid signature → accept, process.
- Invalid signature → reject (401).
- Unsupported verification → reject (400) or require explicit opt-in.

### 2. Differentiator — Intelligent Focus Mode

**Feature:** Time-bounded focus periods with critical event bypass and smart catch-up summaries.

**Behavior:** Hold non-critical notifications during Focus Mode; deliver critical events immediately; correlate related events; generate actionable summary when Focus ends.

**Example:** Student in 2-hour exam prep receives 1 critical alert (exam room 30 min before) instead of 5 separate emails; at end, sees 1 summary: "Exam moved to H123 (confirmed)."

**Why it's new:** Combines focus periods, event correlation, and acknowledgement-aware suppression—absent from original.

**Acceptance criteria:**
- Focus Mode duration configurable.
- Critical events bypass Focus Mode (rules-based).
- Related events correlated by entity key.
- Post-Focus summary generated with deduplication.
- Backward compatible (optional feature).

---

**END OF GAPS.md — Stage 9 Phase 2 Complete**
