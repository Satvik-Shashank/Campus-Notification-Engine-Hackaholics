'use strict';

const { HttpError, parseJson } = require('../util');
const { isUniqueViolation } = require('../db');

const MAX_EXPLICIT = 100;
const MAX_BULK = 100;
const PRIORITIES = ['normal', 'critical'];

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Event ingestion and resumable fan-out.
 * Accepting an event only persists it (202); recipients are resolved and notifications created by
 * the worker, with progress stored per recipient so a failure resumes instead of dropping people.
 */
function createIngest(ctx) {
  const { db, clock, config, logger } = ctx;

  function validate(body, headerKey) {
    if (!isPlainObject(body)) throw new HttpError(400, 'BadRequest', 'Request body must be a JSON object.');
    const transactionId = body.transactionId || headerKey;
    if (!transactionId || typeof transactionId !== 'string' || transactionId.length > 200) {
      throw new HttpError(400, 'BadRequest', 'transactionId (or Idempotency-Key header) is required.');
    }
    if (typeof body.workflowIdentifier !== 'string' || !body.workflowIdentifier) {
      throw new HttpError(400, 'BadRequest', 'workflowIdentifier is required.');
    }
    const workflow = ctx.workflows.getByIdentifier(body.workflowIdentifier);
    if (!workflow || body.workflowIdentifier.startsWith('__')) {
      throw new HttpError(400, 'BadRequest', `Invalid workflowIdentifier: '${body.workflowIdentifier}' not found`);
    }
    if (!isPlainObject(body.payload)) throw new HttpError(400, 'BadRequest', 'payload must be an object.');
    const priority = body.priority ?? 'normal';
    if (!PRIORITIES.includes(priority)) throw new HttpError(400, 'BadRequest', `priority must be one of ${PRIORITIES.join(', ')}.`);
    const to = body.to;
    if (!isPlainObject(to) || !['explicit', 'topic', 'broadcast'].includes(to.type)) {
      throw new HttpError(400, 'BadRequest', 'to.type must be explicit, topic or broadcast.');
    }
    let recipients;
    if (to.type === 'explicit') {
      const ids = to.subscriberIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.some((s) => typeof s !== 'string' || !s)) {
        throw new HttpError(400, 'BadRequest', 'to.subscriberIds must be a non-empty array of strings.');
      }
      if (ids.length > MAX_EXPLICIT) throw new HttpError(400, 'BadRequest', `to.subscriberIds accepts at most ${MAX_EXPLICIT} ids.`);
      recipients = [...new Set(ids)];
    } else if (to.type === 'topic') {
      if (typeof to.topic !== 'string' || !to.topic) throw new HttpError(400, 'BadRequest', 'to.topic is required.');
      recipients = [to.topic];
    } else {
      recipients = [];
    }
    return { transactionId, workflow, payload: body.payload, priority, type: to.type, recipients };
  }

  const recipientCount = (type, recipients) => {
    if (type === 'explicit') return recipients.length;
    if (type === 'topic') return ctx.subscribers.topicMembers(recipients[0]).length;
    return ctx.subscribers.count();
  };

  const cachedResponse = (row) => ({ ...parseJson(row.response, {}), duplicate: true });

  /** Accept one event. Same transactionId inside the dedup window replays the first response. */
  function accept(body, headerKey) {
    const v = validate(body, headerKey);
    const now = clock.now();
    try {
      return db.tx(() => {
        const existing = db.get('SELECT * FROM events WHERE transaction_id = ?', v.transactionId);
        if (existing) {
          if (existing.expires_at > now) return cachedResponse(existing);
          // Dedup window elapsed: archive the old row so the id can be reused as a new event.
          db.run('UPDATE events SET transaction_id = ? WHERE id = ?', `${existing.transaction_id}#expired#${existing.id}`, existing.id);
        }
        const count = recipientCount(v.type, v.recipients);
        const response = {
          status: 'accepted',
          transactionId: v.transactionId,
          workflowId: v.workflow.identifier,
          recipientCount: count,
          message: v.type === 'broadcast' ? 'Broadcast event queued' : 'Event queued for processing',
        };
        db.run(
          `INSERT INTO events (transaction_id, workflow_id, payload, priority, recipient_type, recipients,
             recipient_count, status, next_attempt_at, response, created_at, updated_at, expires_at)
           VALUES (?,?,?,?,?,?,?,'pending',?,?,?,?,?)`,
          v.transactionId, v.workflow.id, JSON.stringify(v.payload), v.priority, v.type, JSON.stringify(v.recipients),
          count, now, JSON.stringify(response), now, now, now + config.dedupWindowMs,
        );
        ctx.activity.log({
          transactionId: v.transactionId, workflowId: v.workflow.id, event: 'event_submitted', status: 'success',
          message: 'Event queued for processing',
        });
        return response;
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Lost a race with a concurrent submit of the same transactionId: replay the winner's response.
      const winner = db.get('SELECT * FROM events WHERE transaction_id = ?', v.transactionId);
      if (winner) return cachedResponse(winner);
      throw err;
    }
  }

  function acceptBulk(body) {
    if (!isPlainObject(body) || !Array.isArray(body.events) || body.events.length === 0) {
      throw new HttpError(400, 'BadRequest', 'events must be a non-empty array.');
    }
    if (body.events.length > MAX_BULK) throw new HttpError(400, 'BadRequest', `events accepts at most ${MAX_BULK} items.`);
    const results = body.events.map((e) => {
      try {
        const r = accept(e);
        return { transactionId: r.transactionId, status: 'accepted', ...(r.duplicate ? { duplicate: true } : {}) };
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        return { transactionId: isPlainObject(e) ? e.transactionId ?? null : null, status: 'rejected', error: err.message };
      }
    });
    const acceptedCount = results.filter((r) => r.status === 'accepted').length;
    return { status: acceptedCount ? 'accepted' : 'rejected', acceptedCount, rejectedCount: results.length - acceptedCount, results };
  }

  function acceptBroadcast(body, headerKey) {
    if (!isPlainObject(body)) throw new HttpError(400, 'BadRequest', 'Request body must be a JSON object.');
    return accept({ ...body, to: { type: 'broadcast' } }, headerKey);
  }

  // ---- fan-out (worker side) ----

  function claimEvents(now) {
    const staleBefore = now - config.jobLockTimeoutMs;
    const due = db.all(
      `SELECT id FROM events
       WHERE (status = 'pending' AND next_attempt_at <= ?) OR (status = 'processing' AND updated_at <= ?)
       ORDER BY id`, now, staleBefore,
    );
    return due.map((r) => r.id).filter((id) => db.run(
      `UPDATE events SET status = 'processing', attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND ((status = 'pending' AND next_attempt_at <= ?) OR (status = 'processing' AND updated_at <= ?))`,
      now, id, now, staleBefore,
    ).changes === 1);
  }

  function resolveRecipients(event) {
    const recipients = parseJson(event.recipients, []);
    if (event.recipient_type === 'explicit') return recipients;
    if (event.recipient_type === 'topic') return ctx.subscribers.topicMembers(recipients[0]);
    return ctx.subscribers.allExternalIds();
  }

  function fanOut(eventId) {
    const now = () => clock.now();
    const event = db.get('SELECT * FROM events WHERE id = ?', eventId);
    const workflow = ctx.workflows.getById(event.workflow_id);
    const payload = parseJson(event.payload, {});
    try {
      db.tx(() => {
        let n = 0;
        for (const ext of resolveRecipients(event)) {
          n += db.run('INSERT OR IGNORE INTO event_recipients (event_id, external_id) VALUES (?,?)', event.id, ext).changes;
        }
        if (n > 0) {
          ctx.activity.log({
            transactionId: event.transaction_id, workflowId: workflow.id, event: 'recipients_resolved', status: 'success',
            message: `${n} subscribers identified (${event.recipient_type})`,
          });
        }
      });
      const bypass = ctx.workflows.isCritical(workflow, payload, event.priority);
      for (;;) {
        const chunk = db.all(
          `SELECT external_id FROM event_recipients WHERE event_id = ? AND state = 'pending' ORDER BY external_id LIMIT ?`,
          event.id, config.fanoutChunkSize,
        );
        if (chunk.length === 0) break;
        db.tx(() => {
          for (const { external_id: ext } of chunk) {
            const sub = ctx.subscribers.byExternal(ext);
            if (!sub) {
              db.run(`UPDATE event_recipients SET state = 'skipped' WHERE event_id = ? AND external_id = ?`, event.id, ext);
              ctx.activity.log({
                transactionId: event.transaction_id, workflowId: workflow.id, event: 'recipient_skipped', status: 'skipped',
                message: `Unknown subscriber '${ext}'`,
              });
              continue;
            }
            ctx.pipeline.createNotification({ event, workflow, subscriber: sub, payload, bypassFocus: bypass, ignoreMutes: workflow.critical });
            db.run(`UPDATE event_recipients SET state = 'done' WHERE event_id = ? AND external_id = ?`, event.id, ext);
          }
        });
      }
      db.run(`UPDATE events SET status = 'processed', last_error = NULL, updated_at = ? WHERE id = ? AND status = 'processing'`, now(), event.id);
      return { processed: true };
    } catch (err) {
      const attempts = event.attempts;
      const final = attempts >= config.fanoutMaxAttempts;
      const backoff = Math.min(60000, 1000 * 2 ** (attempts - 1));
      logger.error('fan-out failed', { eventId: event.id, transactionId: event.transaction_id, attempts, error: err.message });
      db.run(
        `UPDATE events SET status = ?, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?`,
        final ? 'failed' : 'pending', err.message, now() + backoff, now(), event.id,
      );
      ctx.activity.log({
        transactionId: event.transaction_id, workflowId: workflow.id, event: final ? 'fanout_failed' : 'fanout_retry_scheduled',
        status: 'failure', message: final ? 'Fan-out failed permanently' : `Fan-out will retry in ${backoff}ms`,
        attempt: attempts, error: err.message,
      });
      return { processed: false, error: err.message };
    }
  }

  function processDueEvents() {
    const ids = claimEvents(clock.now());
    for (const id of ids) fanOut(id);
    return ids.length;
  }

  return { accept, acceptBulk, acceptBroadcast, processDueEvents };
}

module.exports = { createIngest };
