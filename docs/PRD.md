# PRD.md — Product Requirements Document


## 1. Problem Statement

A university must notify 30,000 students of exam timetable changes. Core challenges:

- **Speed:** Notification must reach students within seconds of event submission.
- **No spam:** A burst of 10 related events (e.g., multiple room changes) should not trigger 10 separate emails.
- **Respect preferences:** A student who muted email must not receive email, regardless of event urgency.
- **Reliability:** Failures must not silently drop notifications or create duplicates.
- **Scale:** The system must handle 30,000 students with asynchronous processing.

## 2. Target Users

### Event Producer (Admin/System)
- **Who:** University admin, registrar system, or automated event pipeline.
- **Need:** Submit notification events; receive confirmation; monitor delivery status.
- **Can do:** 
  - Trigger events with recipient list, payload, and workflow identifier.
  - Check event status and delivery log.
  - Cancel pending/delayed events.

### Student (Subscriber)
- **Who:** University student receiving notifications.
- **Need:** Receive urgent updates on their chosen channels; control notification preferences.
- **Can do:**
  - View in-app notifications in real-time.
  - Mute/unmute email, in-app, or other channels globally or per-workflow.
  - Read notification history.

### Workflow Admin (Optional)
- **Who:** University admin defining notification workflows.
- **Need:** Design workflows (steps, branching, digest grouping).
- **Can do:**
  - Create workflows with steps (digest, email, in-app, etc.).
  - Define digest windows and grouping keys.
  - Set critical/readOnly flags.

## 3. Product Goal

Build a notification engine that:
- Accepts high-volume events (30,000 subscribers per event).
- Respects per-channel user preferences.
- Groups related events into single digests within time windows.
- Delivers via email and in-app notifications.
- Retries failures without creating duplicate messages.
- Records delivery state for observability.

## 4. Core User/System Flow

```
1. Event Producer submits event via API
   - transactionId (idempotency key)
   - workflow identifier
   - recipient list or topic
   - payload (timetable change details)
   
2. API validates, enqueues, returns 202 ACCEPTED

3. Async notification processor
   - Resolves recipients (exact list or topic expansion)
   - Creates Notification record (one per subscriber)
   - Creates Job chain per workflow steps
   
4. Digest step (if present in workflow)
   - Groups events within time window
   - First event becomes master; subsequent merge
   - Emit after window or explicit trigger
   
5. Preference evaluation
   - Check per-channel: email enabled? in-app enabled?
   - Skip step if channel muted
   
6. Delivery
   - Email: send via provider (with idempotency key)
   - In-App: create/update message, emit WebSocket
   
7. Failure handling
   - Retry up to N times with backoff (configurable per channel)
   - Skip duplicate using idempotency key
   - Mark permanently failed after max attempts
   
8. Status recording
   - Job status: PENDING → QUEUED → RUNNING → SUCCESS/FAILED
   - Activity log: step created, sent, failed, retried
```

## 5. Functional Requirements

### FR1: Event Ingestion
- Accept POST request with transactionId, workflow, recipients, payload.
- Validate payload against optional schema.
- Return 202 ACCEPTED immediately (async).
- Detect and reject duplicate transactionId within dedup window (24h).

### FR2: Recipient Resolution
- Support explicit subscriber ID list (up to 100 per request, or batch).
- Support topic-based expansion (resolve all subscribers of topic).
- Support broadcast (all subscribers).

### FR3: Preference Filtering
- Store global preference (email on/off, in-app on/off).
- Store per-workflow preference (override global).
- Evaluate at execution time, not trigger time.
- Skip step if channel muted.
- Critical/readOnly workflows ignore mutes.

### FR4: Digest Grouping
- Digest step groups events by (subscriber, workflow, digestKey/digestValue).
- First event becomes master (DELAYED); subsequent merge.
- Window: time-based (e.g., 5 minutes) or scheduled (e.g., daily at 9am).
- Emit digest when window closes or explicit flush triggered.
- Prevent duplicate masters via atomic constraint.

### FR5: Email Delivery
- Call provider (SendGrid, Mailgun, etc.) with template and payload.
- Pass idempotency key to provider for dedup.
- Retry up to 3 times on transient failure (network, rate limit).
- No retry on permanent error (invalid email, auth failed).
- Mark FAILED and proceed to next step if permanently failed.

### FR6: In-App Delivery
- Create Message record with notification content.
- Deduplication: if same (transactionId, template, step) exists, update; else create new.
- Emit WebSocket event to subscriber in real-time.
- Return success immediately (fire-and-forget, no delivery guarantee).

### FR7: Retry and Idempotency
- Each (notification, step, channel) pair has idempotency key.
- Idempotency key unique per logical delivery (immutable once sent).
- On retry, reuse same key; provider returns cached response if available.
- Failure state tracked; permanent failures do not retry.

### FR8: Observability
- Track job status: PENDING, QUEUED, RUNNING, SUCCESS, FAILED, RETRYING.
- Log each step: created, queued, sent, failed, reason.
- Expose activity feed: event trigger, digest grouping, delivery status.
- Support querying delivery state by subscriber, workflow, or event.

### FR9: Idempotency at API Level
- transactionId prevents duplicate event submission.
- Within 24h window, repeated POST with same transactionId returns same response.
- API-level idempotency cache (Redis).

### FR10: Cancellation
- DELETE /events/trigger/:transactionId cancels pending/delayed jobs.
- Only cancels DELAYED or QUEUED jobs, not in-flight.

## 6. Killer Test Acceptance Criteria

### KT1 — Digest Burst (10 events, 5 minutes, 1 digest)

```
Given:
  - Workflow with Digest step (5-minute window) → Email
  - Digest grouped by (subscriber, workflow, digestValue)
  
When:
  - 10 events triggered within 5 minutes
  - All with same transactionId pattern (or grouped by digestValue)
  - Sent to same subscriber
  
Then:
  - Exactly 1 DELAYED master job created
  - 9 subsequent events MERGED
  - Email sent once after 5-minute window
  - Email contains aggregated content (all 10 events)
```

### KT2 — Preference Filtering (email muted, in-app only)

```
Given:
  - Workflow with Email step → In-App step
  - Subscriber preference: Email disabled, In-App enabled
  
When:
  - Event triggered to subscriber
  
Then:
  - Email step is SKIPPED (not sent, not retried)
  - In-App step is executed (message created, WebSocket emitted)
  - Activity log shows: Email step SKIPPED, In-App step SENT
```

### KT3 — Retry Without Duplicate (failed send, retry, single message)

```
Given:
  - Email step in workflow
  - Subscriber preference: Email enabled
  - Email provider configured
  
When:
  - Event triggered
  - Provider fails (500 error) on first attempt
  - System retries after backoff
  - Provider succeeds on second attempt
  
Then:
  - Email sent exactly once to subscriber
  - Idempotency key used on retry; provider returns cached response
  - Activity log: FAILED (attempt 1) → RETRYING → SENT (attempt 2)
  - No duplicate message in subscriber's inbox
```

## 7. MoSCoW Scope

### Must Have
- Event ingestion API with idempotency.
- Asynchronous job processing.
- Digest grouping with time window.
- Email delivery via provider.
- In-app message creation and WebSocket emit.
- Per-channel preference filtering.
- Retry with idempotency key.
- Activity logging (status, attempts).

### Should Have
- Topic-based recipient expansion.
- Critical workflow (ignores mutes).
- Configurable retry backoff.
- Scheduled digest (time-based vs. scheduled).
- Broadcast to all subscribers.
- Preference override hierarchy.
- Delivery status dashboard.

### Could Have
- SMS delivery.
- Push notifications.
- Custom webhook steps.
- Workflow versioning.
- A/B testing or segmentation.
- In-app notification read/archive.
- Preference history/audit.

### Won't Have
- Chat or social media delivery (out of scope for campus).
- Subscriber authentication beyond JWT.
- Multi-tenant organization support (single campus assumed).
- Workflow UI designer (workflows defined via API/CLI).
- Real-time collaboration on workflows.
- Custom script execution inside workflow.

## 8. User Journey

### Admin: Timetable Change Event

```
1. Registrar system detects exam room change for CS101
2. System calls POST /events/trigger
   - workflow: "exam-update"
   - recipients: [topic: "CS101-students"]
   - payload: { exam: "CS101", room: "H123", time: "2:00 PM" }
   - transactionId: "cs101-room-change-20250505-001"
3. API returns 202 ACCEPTED immediately
4. Async processor:
   - Expands topic "CS101-students" → 150 subscriber IDs
   - Creates Notification (1x per subscriber)
   - Creates Job chain: [Digest (5min)] → [Email] → [In-App]
5. Digest step merges events if another room change arrives within 5 min
6. After 5 min, digest emits:
   - Email: "Exam Updates: CS101 room changed to H123"
   - In-App: Notification + WebSocket emit
7. Student sees:
   - Real-time in-app notification
   - Email in inbox (if email enabled)
8. Activity log shows:
   - Event trigger at T0
   - Digest: 1 master, 0 merged
   - Email: sent at T+5min
   - In-App: sent at T+5min
   - Status: DELIVERED
```

## 9. Non-Functional Requirements

### NFR1: Reliability
- At-most-once for workflow/subscriber processing (no retries after fan-out).
- Exactly-once for step delivery (idempotency key prevents duplicates).
- No data loss for triggered events (persist before async).

### NFR2: Duplicate Prevention
- transactionId uniqueness within 24h.
- (notification, step, channel) idempotency key uniqueness.
- Prevent re-sending same email via provider idempotency.

### NFR3: Latency
- API response: <500ms.
- Subscriber processing: <1s per 100 subscribers.
- Delivery: <10s for email + in-app in normal conditions.
- Digest emit: on-window or within timeout.

### NFR4: Scalability
- Support 30,000 subscribers per event.
- Asynchronous fan-out (no blocking API call).
- Concurrent workers: assume 200+ simultaneous jobs.
- Batch operations where possible (fan-out in chunks).

### NFR5: Consistency
- Job chain order preserved (no out-of-order execution).
- Preference read-after-write within 1 second (primary DB read for preferences).
- Digest grouping atomic (no split masters or races).

### NFR6: Fault Tolerance
- Worker crash: job can be reclaimed after lock timeout (e.g., 90s).
- Database unavailable: queue jobs, retry after service restored.
- Provider unavailable: retry with backoff, eventually fail.

### NFR7: Observability
- Activity log for every event, every step, every attempt.
- Queryable by (subscriber, workflow, transactionId, timestamp).
- Status breakdown: sent, failed, retrying, skipped, merged.

## 10. Out of Scope

- **Multi-tenant:** single campus assumed.
- **Subscriber authentication:** beyond API/JWT.
- **Workflow visual designer:** workflows defined via API.
- **SMS/Push/Chat:** email + in-app only for MVP.
- **Notification preferences UI:** preference API exists; UI delegated.
- **Webhook callbacks:** no provider → system callbacks.
- **Real-time analytics:** activity log is queryable; no real-time dashboard.
- **A/B testing:** not a feature for campus notifications.
- **Workflow templates:** workflows created explicitly per campus.

---

**Cross-Cutting:** All three Killer Tests must pass as acceptance criteria. All Must-Have requirements are non-negotiable. Gaps identified in reverse engineering (e.g., email retry) are addressed in the rebuild.
