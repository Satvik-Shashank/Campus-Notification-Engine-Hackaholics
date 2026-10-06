# API.md — API Contract

## 1. API Principles

The Campus Notification Engine exposes:

- **Public APIs:** For event producers, subscribers, and admins to interact with the system.
- **Internal APIs:** Worker-to-worker communication (queues, internal services).
- **Authentication:** API key (for event producers) or JWT (for subscribers).
- **Async-first:** Event ingestion returns 202 ACCEPTED immediately; processing happens asynchronously.
- **Idempotency:** Requests with same transactionId return same response (24h window).

## 2. Endpoint Table (Summary)

| Method | Path | Purpose | Auth | Response |
|---|---|---|---|---|
| **POST** | /events/trigger | Submit single event | API Key | 202 ACCEPTED |
| **POST** | /events/trigger/bulk | Bulk submit events | API Key | 202 ACCEPTED |
| **POST** | /events/trigger/broadcast | Broadcast to all subscribers | API Key | 202 ACCEPTED |
| **DELETE** | /events/trigger/:transactionId | Cancel pending/delayed event | API Key | 200 OK |
| **POST** | /inbox/session | Create subscriber JWT | Public | 200 OK + JWT |
| **GET** | /inbox/notifications | Fetch in-app notifications | Subscriber JWT | 200 OK + list |
| **GET** | /inbox/preferences | Read subscriber preferences | Subscriber JWT | 200 OK + preferences |
| **PATCH** | /inbox/preferences | Update global preferences | Subscriber JWT | 200 OK |
| **PATCH** | /inbox/preferences/:workflowId | Update workflow-level preferences | Subscriber JWT | 200 OK |
| **GET** | /admin/activity | Activity log / event drill-down | API Key | 200 OK + log |
| **GET** | /admin/notifications/:transactionId | Check event delivery status | API Key | 200 OK + status |

---

## 3. Event Ingestion

### POST /events/trigger — Single Event

Submit a notification event to one or more subscribers.

**Request:**

```json
POST /events/trigger HTTP/1.1
Authorization: Bearer api_key_xyz
Content-Type: application/json

{
  "transactionId": "exam-update-cs101-20250505-001",
  "workflowIdentifier": "exam-room-change",
  "to": {
    "type": "explicit",
    "subscriberIds": ["student_001", "student_002", "student_003"]
  },
  "payload": {
    "exam": "CS101",
    "room": "H123",
    "time": "2:00 PM",
    "building": "Health Sciences"
  }
}
```

**Request Body Fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| **transactionId** | String | Yes | Unique identifier (UUID or custom). Used for idempotency. |
| **workflowIdentifier** | String | Yes | Workflow name or ID to execute. |
| **to** | Object | Yes | Recipient specification. |
| **to.type** | Enum | Yes | "explicit" (subscriber IDs), "topic" (topic name), "broadcast" (all subscribers). |
| **to.subscriberIds** | [String] | Conditional | Required if type="explicit". Subscriber IDs. Max 100 per request. |
| **to.topic** | String | Conditional | Required if type="topic". Topic name (e.g., "CS101-students"). |
| **payload** | Object | Yes | Event data (exam room, time, details). Passed to email/in-app templates. |
| **idempotencyKey** (HTTP header) | String | Optional | Alternative to transactionId. Header: `Idempotency-Key: ...` |

**Response: 202 ACCEPTED**

```json
HTTP/1.1 202 Accepted
Content-Type: application/json

{
  "status": "accepted",
  "transactionId": "exam-update-cs101-20250505-001",
  "workflowId": "wf_abc123",
  "recipientCount": 3,
  "message": "Event queued for processing"
}
```

**Response Fields:**

| Field | Type | Description |
|---|---|---|
| status | String | "accepted" (always 202 for valid requests). |
| transactionId | String | Echo of request transactionId. |
| workflowId | String | Internal workflow ID (for reference). |
| recipientCount | Int | Number of subscribers who will receive. |
| message | String | Human-readable status. |

**Errors:**

| Status | Error | Reason |
|---|---|---|
| 400 | BadRequest | Invalid workflowIdentifier, malformed payload, invalid subscriber IDs. |
| 409 | Conflict | Duplicate transactionId (same request already submitted within 24h). Returns previous 202 response. |
| 401 | Unauthorized | Invalid API key. |
| 429 | TooManyRequests | Rate limit exceeded (e.g., 100 events per minute per API key). |

**Idempotency Behavior:**

If same transactionId is submitted twice within 24h:
- First request: 202 ACCEPTED, event queued.
- Duplicate request: 202 ACCEPTED, same response returned (cached, no duplicate queued).
- After 24h: transactionId can be reused; treated as new event.

---

### POST /events/trigger/bulk — Batch Submit

Submit multiple events in one request (internal batching for convenience).

**Request:**

```json
POST /events/trigger/bulk HTTP/1.1
Authorization: Bearer api_key_xyz
Content-Type: application/json

{
  "events": [
    {
      "transactionId": "exam-cs101-001",
      "workflowIdentifier": "exam-update",
      "to": { "type": "topic", "topic": "CS101-students" },
      "payload": { "exam": "CS101", "room": "H123" }
    },
    {
      "transactionId": "exam-math201-001",
      "workflowIdentifier": "exam-update",
      "to": { "type": "topic", "topic": "MATH201-students" },
      "payload": { "exam": "MATH201", "room": "H124" }
    }
  ]
}
```

**Request Body:**

| Field | Type | Description |
|---|---|---|
| events | [Object] | Array of event objects (same schema as /events/trigger). Max 100 events per request. |

**Response: 202 ACCEPTED**

```json
HTTP/1.1 202 Accepted
Content-Type: application/json

{
  "status": "accepted",
  "acceptedCount": 2,
  "rejectedCount": 0,
  "results": [
    { "transactionId": "exam-cs101-001", "status": "accepted" },
    { "transactionId": "exam-math201-001", "status": "accepted" }
  ]
}
```

**Errors:**

| Status | Reason |
|---|---|
| 400 | One or more events malformed (details in results). Accepted events are still queued. |
| 401 | Unauthorized. |
| 429 | Rate limit exceeded. |

---

### POST /events/trigger/broadcast — Broadcast Event

Submit event to all subscribers (no explicit recipient list).

**Request:**

```json
POST /events/trigger/broadcast HTTP/1.1
Authorization: Bearer api_key_xyz
Content-Type: application/json

{
  "transactionId": "campuswide-alert-20250505",
  "workflowIdentifier": "emergency-alert",
  "payload": {
    "title": "Campus Closed",
    "reason": "Weather emergency",
    "duration": "until further notice"
  }
}
```

**Response: 202 ACCEPTED**

```json
{
  "status": "accepted",
  "transactionId": "campuswide-alert-20250505",
  "recipientCount": 30000,
  "message": "Broadcast event queued"
}
```

---

### DELETE /events/trigger/:transactionId — Cancel Event

Cancel a pending or delayed event.

**Request:**

```
DELETE /events/trigger/exam-update-cs101-20250505-001 HTTP/1.1
Authorization: Bearer api_key_xyz
```

**Response: 200 OK**

```json
{
  "status": "canceled",
  "transactionId": "exam-update-cs101-20250505-001",
  "canceledJobCount": 5,
  "message": "Event canceled. 5 pending jobs removed."
}
```

**Errors:**

| Status | Reason |
|---|---|
| 404 | Event not found or already delivered (no jobs to cancel). |
| 401 | Unauthorized. |

**Behavior:**
- Cancels all PENDING and DELAYED jobs for this transactionId.
- Does NOT cancel jobs already RUNNING or COMPLETED.
- Idempotent: calling twice returns same response (no jobs to cancel second time).

---

## 4. Preference Management

### GET /inbox/preferences — Read Preferences

Fetch subscriber's global and workflow-level preferences.

**Request:**

```
GET /inbox/preferences HTTP/1.1
Authorization: Bearer subscriber_jwt_xyz
```

**Response: 200 OK**

```json
{
  "subscriberId": "student_001",
  "global": {
    "email": true,
    "inApp": true
  },
  "workflows": {
    "exam-updates": {
      "email": false,
      "inApp": true
    },
    "grade-alerts": {
      "email": true,
      "inApp": true
    }
  }
}
```

**Response Fields:**

| Field | Type | Description |
|---|---|---|
| subscriberId | String | Subscriber's external ID. |
| global | Object | Global preference (applies to all workflows). |
| global.email | Boolean | Email enabled (default true). |
| global.inApp | Boolean | In-app enabled (default true). |
| workflows | Object | Per-workflow overrides (optional). |
| workflows.[workflowId] | Object | Workflow-specific override. |

**Errors:**

| Status | Reason |
|---|---|
| 401 | Invalid or expired JWT. |
| 404 | Subscriber not found. |

---

### PATCH /inbox/preferences — Update Global Preferences

Update global notification preferences (applies to all workflows unless overridden).

**Request:**

```json
PATCH /inbox/preferences HTTP/1.1
Authorization: Bearer subscriber_jwt_xyz
Content-Type: application/json

{
  "email": false,
  "inApp": true
}
```

**Request Body:**

| Field | Type | Description |
|---|---|---|
| email | Boolean | Optional. Enable/disable email notifications. |
| inApp | Boolean | Optional. Enable/disable in-app notifications. |

**Response: 200 OK**

```json
{
  "status": "updated",
  "subscriberId": "student_001",
  "global": {
    "email": false,
    "inApp": true
  }
}
```

**Errors:**

| Status | Reason |
|---|---|
| 400 | Invalid request (empty body or invalid fields). |
| 401 | Unauthorized. |
| 404 | Subscriber not found. |

**KT2 Impact:** Setting email=false globally mutes all emails. Workflows can override this.

---

### PATCH /inbox/preferences/:workflowId — Update Workflow Preference

Override global preference for a specific workflow.

**Request:**

```json
PATCH /inbox/preferences/exam-updates HTTP/1.1
Authorization: Bearer subscriber_jwt_xyz
Content-Type: application/json

{
  "email": false,
  "inApp": true
}
```

**Response: 200 OK**

```json
{
  "status": "updated",
  "subscriberId": "student_001",
  "workflowId": "exam-updates",
  "preferences": {
    "email": false,
    "inApp": true
  }
}
```

**Errors:**

| Status | Reason |
|---|---|
| 400 | Invalid request. |
| 401 | Unauthorized. |
| 404 | Subscriber or workflow not found. |

---

## 5. Notification / In-App Retrieval

### GET /inbox/notifications — Fetch In-App Notifications

Retrieve subscriber's in-app notification feed.

**Request:**

```
GET /inbox/notifications?limit=20&offset=0 HTTP/1.1
Authorization: Bearer subscriber_jwt_xyz
```

**Query Parameters:**

| Param | Type | Description |
|---|---|---|
| limit | Int | Max notifications to return (default 20, max 100). |
| offset | Int | Pagination offset (default 0). |
| seen | Boolean | Optional. Filter by seen status (true/false). |

**Response: 200 OK**

```json
{
  "subscriberId": "student_001",
  "total": 45,
  "notifications": [
    {
      "messageId": "msg_001",
      "notificationId": "notif_001",
      "workflowId": "exam-updates",
      "content": "CS101 room changed to H123",
      "subject": "Exam Update",
      "seen": false,
      "archived": false,
      "createdAt": "2025-05-05T14:30:00Z",
      "updatedAt": "2025-05-05T14:30:00Z"
    },
    {
      "messageId": "msg_002",
      "notificationId": "notif_002",
      "workflowId": "grade-alerts",
      "content": "Grade posted: CS101 Midterm",
      "subject": "Grade Alert",
      "seen": true,
      "archived": false,
      "createdAt": "2025-05-04T10:00:00Z",
      "updatedAt": "2025-05-04T10:30:00Z"
    }
  ]
}
```

**Errors:**

| Status | Reason |
|---|---|
| 401 | Unauthorized. |
| 404 | Subscriber not found. |

---

## 6. Activity and Status (Admin APIs)

### GET /admin/activity — Activity Log / Drill-Down

Query activity log for events, jobs, and delivery status.

**Request:**

```
GET /admin/activity?transactionId=exam-update-cs101&limit=50 HTTP/1.1
Authorization: Bearer api_key_xyz
```

**Query Parameters:**

| Param | Type | Description |
|---|---|---|
| transactionId | String | Filter by event transactionId. |
| subscriberId | String | Filter by subscriber. |
| workflowId | String | Filter by workflow. |
| status | String | Filter by status (success, failure, skipped). |
| limit | Int | Max results (default 50, max 500). |
| offset | Int | Pagination offset. |

**Response: 200 OK**

```json
{
  "transactionId": "exam-update-cs101-20250505-001",
  "events": [
    {
      "timestamp": "2025-05-05T14:00:00Z",
      "event": "event_submitted",
      "status": "success",
      "details": "Event queued for processing"
    },
    {
      "timestamp": "2025-05-05T14:00:05Z",
      "event": "recipients_resolved",
      "status": "success",
      "details": "150 subscribers identified (topic: CS101-students)"
    },
    {
      "timestamp": "2025-05-05T14:00:10Z",
      "event": "digest_master_created",
      "status": "success",
      "subscriberId": "student_001",
      "details": "Digest master job created (5-minute window)"
    },
    {
      "timestamp": "2025-05-05T14:05:00Z",
      "event": "digest_emitted",
      "status": "success",
      "subscriberId": "student_001",
      "details": "Digest window closed; 1 email + 1 in-app sent"
    },
    {
      "timestamp": "2025-05-05T14:05:01Z",
      "event": "email_sent",
      "status": "success",
      "subscriberId": "student_001",
      "details": "Email sent to student@university.edu (provider ID: sg_123abc)"
    },
    {
      "timestamp": "2025-05-05T14:05:02Z",
      "event": "inapp_created",
      "status": "success",
      "subscriberId": "student_001",
      "details": "In-app message created; WebSocket emitted"
    }
  ]
}
```

**Errors:**

| Status | Reason |
|---|---|
| 401 | Unauthorized. |
| 404 | TransactionId not found. |

---

### GET /admin/notifications/:transactionId — Event Delivery Status

Get high-level delivery status for a single event.

**Request:**

```
GET /admin/notifications/exam-update-cs101-20250505-001 HTTP/1.1
Authorization: Bearer api_key_xyz
```

**Response: 200 OK**

```json
{
  "transactionId": "exam-update-cs101-20250505-001",
  "workflowId": "exam-updates",
  "submittedAt": "2025-05-05T14:00:00Z",
  "status": "delivered",
  "recipientStats": {
    "total": 150,
    "emailSent": 140,
    "emailFailed": 5,
    "emailSkipped": 5,
    "inAppSent": 145,
    "inAppFailed": 0,
    "inAppSkipped": 5
  }
}
```

**Response Fields:**

| Field | Type | Description |
|---|---|---|
| status | String | Overall status: "processing", "partially_sent", "delivered", "failed". |
| recipientStats | Object | Delivery breakdown by channel. |

---

## 7. Authentication

### POST /inbox/session — Create Subscriber JWT

Generate a JWT for a subscriber to access inbox APIs.

**Request:**

```json
POST /inbox/session HTTP/1.1
Content-Type: application/json

{
  "organizationId": "org_xyz",
  "subscriberId": "student_001"
}
```

**Request Body:**

| Field | Type | Description |
|---|---|---|
| organizationId | String | Organization/campus ID. |
| subscriberId | String | Subscriber's external ID. |

**Response: 200 OK**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresIn": 3600,
  "subscriberId": "student_001"
}
```

**Response Fields:**

| Field | Type | Description |
|---|---|---|
| token | String | JWT (valid for 1 hour by default). |
| expiresIn | Int | Seconds until expiration. |

**Errors:**

| Status | Reason |
|---|---|
| 400 | Invalid request (missing fields). |
| 404 | Organization or subscriber not found. |

---

## 8. Digest Behavior (API Implication)

Digest is a workflow step, not explicitly triggered via API. However:

**Implicit Digest Flow:**

1. Caller submits event with transactionId=T1 → API returns 202.
2. Worker creates Job1 (digest step) with status=DELAYED.
3. Caller submits another event with transactionId=T2, same workflow → 202.
4. Worker attempts to create Job2 (digest step).
5. If Job2 is created within the digest window:
   - Unique index check: (subscriber, workflow, digestValue) already exists in DELAYED status.
   - Job2 marked MERGED, linked to Job1 (master).
   - Caller receives 202 for T2, but Job2 is not independently queued.
6. After window (e.g., 5 minutes):
   - Job1 transitions from DELAYED to QUEUED.
   - Email/In-App steps execute once (aggregated).
   - Job2 remains MERGED (silent skip).

**Caller perspective:**
- Submit event 1 → 202 ACCEPTED.
- Submit event 2 → 202 ACCEPTED.
- Poll /admin/activity/:transactionId → see both events merged under 1 email/in-app.

**No API parameter controls digest grouping.** Digest is defined in workflow (digest step configuration). API caller has no explicit digest API.

---

## 9. Retry Behavior (API Implication)

Retry happens internally; no explicit retry API.

**Caller perspective:**

- Submit event → 202 ACCEPTED.
- Delivery succeeds → activity log shows "SENT".
- Delivery fails (transient) → system retries up to 3 times → eventually "SENT" or "FAILED".
- Caller can query /admin/activity/transactionId to see retry attempts.

**No manual retry API.** Retries are automatic and transparent.

---

## 10. Error Cases

### Invalid Input

**400 Bad Request:**
```json
{
  "error": "BadRequest",
  "message": "Invalid workflowIdentifier: 'unknown-workflow' not found",
  "timestamp": "2025-05-05T14:00:00Z"
}
```

### Duplicate Event

**409 Conflict:**
```json
{
  "error": "Conflict",
  "message": "Event already submitted with transactionId 'exam-update-cs101-001'. Returning cached response.",
  "cachedResponse": {
    "status": "accepted",
    "transactionId": "exam-update-cs101-001",
    "recipientCount": 150
  }
}
```

### Rate Limited

**429 Too Many Requests:**
```json
{
  "error": "TooManyRequests",
  "message": "Rate limit exceeded. Max 100 events per minute.",
  "retryAfter": 5
}
```

### Unauthorized

**401 Unauthorized:**
```json
{
  "error": "Unauthorized",
  "message": "Invalid or missing API key."
}
```

---

## 11. Killer Test Mapping

| Killer Test | API Behavior |
|---|---|
| **KT1: Ten events → one digest** | Submit 10 POST /events/trigger calls with same workflow + digestValue within 5 min. Query GET /admin/activity/transactionId_1 and transactionId_10 → see both merged under 1 email/in-app delivery. |
| **KT2: Email muted → in-app only** | PATCH /inbox/preferences { "email": false }. Submit event. Query GET /admin/activity/transactionId → see email step SKIPPED, in-app step SENT. No email in activity log. |
| **KT3: Retry without duplicate** | Submit event. Let email provider fail. System retries (internal). Query GET /admin/activity/transactionId → see attempts 1, 2, 3; final status SENT. Subscriber inbox shows 1 email, not 3. |

---

**API Stability:** This contract captures essential operations. Additional endpoints (e.g., workflow CRUD, subscriber management) can be added without breaking existing calls. Idempotency applies to POST requests via transactionId header or body field.
