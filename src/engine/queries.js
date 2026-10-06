'use strict';

const { HttpError, toIso } = require('../util');

const clampInt = (value, def, min, max) => {
  if (value === undefined || value === '') return def;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) throw new HttpError(400, 'BadRequest', 'limit/offset must be non-negative integers.');
  return Math.min(n, max);
};

/** Read-side queries for the inbox and admin endpoints. */
function createQueries(ctx) {
  const { db } = ctx;

  return {
    activity(q) {
      const where = [];
      const params = [];
      if (q.transactionId) { where.push('a.transaction_id = ?'); params.push(q.transactionId); }
      if (q.subscriberId) { where.push('s.external_id = ?'); params.push(q.subscriberId); }
      if (q.workflowId) { where.push('w.identifier = ?'); params.push(q.workflowId); }
      if (q.status) {
        if (!['success', 'failure', 'skipped', 'info'].includes(q.status)) throw new HttpError(400, 'BadRequest', 'Invalid status filter.');
        where.push('a.status = ?'); params.push(q.status);
      }
      const limit = clampInt(q.limit, 50, 0, 500);
      const offset = clampInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const from = `FROM activity_log a LEFT JOIN subscribers s ON s.id = a.subscriber_id
                    LEFT JOIN workflows w ON w.id = a.workflow_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
      const total = db.get(`SELECT COUNT(*) AS n ${from}`, ...params).n;
      if (q.transactionId && total === 0 && !db.get('SELECT 1 AS x FROM events WHERE transaction_id = ?', q.transactionId)) {
        throw new HttpError(404, 'NotFound', `transactionId '${q.transactionId}' not found.`);
      }
      const rows = db.all(
        `SELECT a.*, s.external_id AS sub_ext, w.identifier AS wf ${from} ORDER BY a.id LIMIT ? OFFSET ?`, ...params, limit, offset,
      );
      return {
        ...(q.transactionId ? { transactionId: q.transactionId } : {}),
        total,
        events: rows.map((r) => ({
          timestamp: toIso(r.created_at), event: r.event, status: r.status,
          ...(r.sub_ext ? { subscriberId: r.sub_ext } : {}), ...(r.wf ? { workflowId: r.wf } : {}),
          ...(r.step_type ? { stepType: r.step_type } : {}), ...(r.attempt != null ? { attempt: r.attempt } : {}),
          details: r.message, ...(r.error ? { error: r.error } : {}),
        })),
      };
    },

    notificationStatus(transactionId) {
      const event = db.get(
        `SELECT e.*, w.identifier AS wf FROM events e JOIN workflows w ON w.id = e.workflow_id WHERE e.transaction_id = ?`, transactionId,
      );
      if (!event) throw new HttpError(404, 'NotFound', `transactionId '${transactionId}' not found.`);
      const rows = db.all('SELECT delivery_email AS e, delivery_in_app AS i, status FROM notifications WHERE transaction_id = ?', transactionId);
      const count = (key, v) => rows.filter((r) => r[key] === v).length;
      const stats = {
        total: rows.length,
        emailSent: count('e', 'sent'), emailFailed: count('e', 'failed'), emailSkipped: count('e', 'skipped'),
        emailDeferred: count('e', 'deferred') + count('e', 'summarized'),
        inAppSent: count('i', 'sent'), inAppFailed: count('i', 'failed'), inAppSkipped: count('i', 'skipped'),
        inAppDeferred: count('i', 'deferred') + count('i', 'summarized'),
        digested: rows.filter((r) => r.status === 'digested').length,
        held: rows.filter((r) => r.status === 'held').length,
      };
      const open = rows.some((r) => ['pending', 'processing'].includes(r.status));
      const failed = rows.filter((r) => r.status === 'failed').length;
      const partial = rows.filter((r) => r.status === 'partially_sent').length;
      let status;
      if (event.status === 'canceled') status = 'canceled';
      else if (event.status === 'failed') status = 'failed';
      else if (event.status !== 'processed' || open) status = 'processing';
      else if (failed === rows.length && rows.length > 0) status = 'failed';
      else if (failed > 0 || partial > 0) status = 'partially_sent';
      else status = 'delivered';
      return {
        transactionId, workflowId: event.wf, submittedAt: toIso(event.created_at), status,
        ...(event.last_error ? { lastError: event.last_error } : {}), recipientStats: stats,
      };
    },

    inbox(subscriber, q) {
      const limit = clampInt(q.limit, 20, 1, 100);
      const offset = clampInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      const where = [`m.subscriber_id = ?`, `m.channel = 'in-app'`];
      const params = [subscriber.id];
      if (q.seen !== undefined) {
        if (!['true', 'false'].includes(String(q.seen))) throw new HttpError(400, 'BadRequest', 'seen must be true or false.');
        where.push('m.seen = ?'); params.push(String(q.seen) === 'true' ? 1 : 0);
      }
      if (q.archived !== undefined) {
        if (!['true', 'false'].includes(String(q.archived))) throw new HttpError(400, 'BadRequest', 'archived must be true or false.');
        where.push('m.archived = ?'); params.push(String(q.archived) === 'true' ? 1 : 0);
      }
      const total = db.get(`SELECT COUNT(*) AS n FROM messages m WHERE ${where.join(' AND ')}`, ...params).n;
      const rows = db.all(
        `SELECT m.*, w.identifier AS wf FROM messages m JOIN notifications n ON n.id = m.notification_id
           JOIN workflows w ON w.id = n.workflow_id WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC, m.id DESC LIMIT ? OFFSET ?`,
        ...params, limit, offset,
      );
      return {
        subscriberId: subscriber.external_id,
        total,
        notifications: rows.map((m) => ({
          messageId: `msg_${m.id}`, notificationId: `notif_${m.notification_id}`, workflowId: m.wf,
          content: m.content, subject: m.subject, seen: !!m.seen, archived: !!m.archived,
          createdAt: toIso(m.created_at), updatedAt: toIso(m.updated_at),
        })),
      };
    },

    /** Archive or unarchive one of the caller's own in-app messages (archiving also marks it seen). */
    setArchived(subscriber, messageId, archived) {
      if (typeof archived !== 'boolean') throw new HttpError(400, 'BadRequest', 'archived must be a boolean.');
      const m = /^msg_(\d+)$/.exec(String(messageId));
      const row = m && db.get(`SELECT id FROM messages WHERE id = ? AND subscriber_id = ? AND channel = 'in-app'`, Number(m[1]), subscriber.id);
      if (!row) throw new HttpError(404, 'NotFound', 'Message not found.');
      db.run(`UPDATE messages SET archived = ?, seen = CASE WHEN ? = 1 THEN 1 ELSE seen END, updated_at = ? WHERE id = ?`,
        archived ? 1 : 0, archived ? 1 : 0, ctx.clock.now(), row.id);
      return { status: 'updated', messageId: `msg_${row.id}`, archived };
    },

    /** Marks one of the caller's own in-app messages as seen. */
    markSeen(subscriber, messageId) {
      const m = /^msg_(\d+)$/.exec(String(messageId));
      const row = m && db.get(`SELECT id FROM messages WHERE id = ? AND subscriber_id = ? AND channel = 'in-app'`, Number(m[1]), subscriber.id);
      // Same 404 for "does not exist" and "belongs to someone else" so ids cannot be probed.
      if (!row) throw new HttpError(404, 'NotFound', 'Message not found.');
      db.run('UPDATE messages SET seen = 1, updated_at = ? WHERE id = ?', ctx.clock.now(), row.id);
      return { status: 'updated', messageId: `msg_${row.id}`, seen: true };
    },
  };
}

module.exports = { createQueries };
