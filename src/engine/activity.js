'use strict';

/**
 * Append one activity-log row. Never logs payload bodies or secrets, only identifiers and messages.
 * Fields: transactionId, notificationId, jobId, subscriberId, workflowId, stepType, event, status,
 *         message, attempt, error.
 */
function createActivity(ctx) {
  return {
    log(f) {
      ctx.db.run(
        `INSERT INTO activity_log
           (transaction_id, notification_id, job_id, subscriber_id, workflow_id, step_type,
            event, status, message, attempt, error, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        f.transactionId ?? null, f.notificationId ?? null, f.jobId ?? null, f.subscriberId ?? null,
        f.workflowId ?? null, f.stepType ?? null, f.event, f.status || 'info', f.message ?? null,
        f.attempt ?? null, f.error ?? null, ctx.clock.now(),
      );
      ctx.logger.debug(f.event, {
        transactionId: f.transactionId, notificationId: f.notificationId, jobId: f.jobId,
        status: f.status, attempt: f.attempt,
      });
    },
  };
}

module.exports = { createActivity };
