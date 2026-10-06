'use strict';

const { HttpError, toIso } = require('../util');

/**
 * Dead-letter queue (G7). Rows are written by the pipeline when a delivery job fails for good.
 * Retrying re-queues the SAME job, so it keeps its idempotency key: a retried letter can never
 * produce a second logical message, and attempt numbers keep counting up (history is preserved).
 */
function createDeadLetters(ctx) {
  const { db, clock, config } = ctx;

  const view = (r) => ({
    id: r.id, status: r.status, channel: r.channel, reason: r.reason, lastError: r.last_error, attempts: r.attempts,
    transactionId: r.transaction_id, subscriberId: r.sub_ext, workflowId: r.wf, jobId: r.job_id,
    notificationId: r.notification_id, createdAt: toIso(r.created_at), updatedAt: toIso(r.updated_at),
    resolvedAt: toIso(r.resolved_at),
  });

  const base = `FROM dead_letters d JOIN subscribers s ON s.id = d.subscriber_id JOIN workflows w ON w.id = d.workflow_id`;

  function requeue(letter) {
    const job = db.get('SELECT * FROM jobs WHERE id = ?', letter.job_id);
    if (!job || job.status !== 'failed') return false;
    const now = clock.now();
    db.run(
      `UPDATE jobs SET status = 'queued', run_at = ?, next_retry_at = NULL, last_error = NULL, completed_at = NULL,
         locked_at = NULL, max_attempts = attempts + ?, updated_at = ? WHERE id = ?`,
      now, config.emailMaxAttempts, now, job.id,
    );
    ctx.pipeline.setDelivery(job.notification_id, job.step_type, 'pending');
    ctx.pipeline.rollup(job.notification_id);
    db.run(`UPDATE dead_letters SET status = 'retried', resolved_at = ?, updated_at = ? WHERE id = ?`, now, now, letter.id);
    ctx.activity.log({
      transactionId: job.transaction_id, notificationId: job.notification_id, jobId: job.id, subscriberId: job.subscriber_id,
      workflowId: job.workflow_id, stepType: job.step_type, event: 'dlq_retried', status: 'info',
      message: `Operator re-queued dead letter ${letter.id} (same idempotency key)`,
    });
    return true;
  }

  return {
    list(q = {}) {
      const where = [];
      const params = [];
      if (q.status) {
        if (!['open', 'retried', 'dismissed'].includes(q.status)) throw new HttpError(400, 'BadRequest', 'status must be open, retried or dismissed.');
        where.push('d.status = ?'); params.push(q.status);
      }
      if (q.transactionId) { where.push('d.transaction_id = ?'); params.push(q.transactionId); }
      if (q.subscriberId) { where.push('s.external_id = ?'); params.push(q.subscriberId); }
      if (q.workflowId) { where.push('w.identifier = ?'); params.push(q.workflowId); }
      const limit = Math.min(Math.max(Number.parseInt(q.limit ?? '50', 10) || 50, 1), 500);
      const offset = Math.max(Number.parseInt(q.offset ?? '0', 10) || 0, 0);
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = db.get(`SELECT COUNT(*) AS n ${base} ${w}`, ...params).n;
      const rows = db.all(
        `SELECT d.*, s.external_id AS sub_ext, w.identifier AS wf ${base} ${w} ORDER BY d.id DESC LIMIT ? OFFSET ?`,
        ...params, limit, offset,
      );
      return { total, deadLetters: rows.map(view) };
    },

    countOpen: () => db.get(`SELECT COUNT(*) AS n FROM dead_letters WHERE status = 'open'`).n,

    retry(id) {
      return db.tx(() => {
        const letter = db.get('SELECT * FROM dead_letters WHERE id = ?', id);
        if (!letter) throw new HttpError(404, 'NotFound', 'Dead letter not found.');
        if (letter.status !== 'open') throw new HttpError(409, 'Conflict', `Dead letter is already ${letter.status}.`);
        if (!requeue(letter)) throw new HttpError(409, 'Conflict', 'The job is no longer in a failed state.');
        return { status: 'retried', id: letter.id, jobId: letter.job_id };
      });
    },

    retryTransaction(transactionId) {
      if (!transactionId || typeof transactionId !== 'string') throw new HttpError(400, 'BadRequest', 'transactionId is required.');
      return db.tx(() => {
        const letters = db.all(`SELECT * FROM dead_letters WHERE transaction_id = ? AND status = 'open'`, transactionId);
        let retried = 0;
        for (const l of letters) if (requeue(l)) retried += 1;
        return { status: 'retried', transactionId, retried };
      });
    },

    dismiss(id) {
      return db.tx(() => {
        const letter = db.get('SELECT * FROM dead_letters WHERE id = ?', id);
        if (!letter) throw new HttpError(404, 'NotFound', 'Dead letter not found.');
        if (letter.status !== 'open') throw new HttpError(409, 'Conflict', `Dead letter is already ${letter.status}.`);
        const now = clock.now();
        db.run(`UPDATE dead_letters SET status = 'dismissed', resolved_at = ?, updated_at = ? WHERE id = ?`, now, now, id);
        return { status: 'dismissed', id };
      });
    },
  };
}

module.exports = { createDeadLetters };
