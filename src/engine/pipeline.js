'use strict';

const { sha256Hex, parseJson, renderTemplate } = require('../util');
const { isUniqueViolation } = require('../db');
const { ProviderError } = require('../providers/email');

const UNFINISHED = ['pending', 'queued', 'running', 'retrying', 'delayed'];

/**
 * Notification + job-chain pipeline.
 *
 * Identities kept apart on purpose:
 *   event        -> events row (transaction_id)
 *   notification -> notifications row, unique per (event, subscriber)
 *   attempt      -> delivery_attempts row, unique per (job, attempt_no)
 *   provider     -> messages.provider_message_id / provider_status
 * A retry only adds a delivery_attempts row; it never creates a notification or a second message,
 * because the message is keyed by an idempotency key derived from (notification, step, channel).
 */
function createPipeline(ctx) {
  const { db, clock, config, logger } = ctx;
  const maxDeliveryAttempts = () => config.emailMaxAttempts;

  const idempotencyKey = (notificationId, stepIndex, type) =>
    `idem_${sha256Hex(`${notificationId}:${stepIndex}:${type}`).slice(0, 32)}`;

  const getJob = (id) => db.get('SELECT * FROM jobs WHERE id = ?', id);
  const getNotification = (id) => db.get('SELECT * FROM notifications WHERE id = ?', id);

  function setDelivery(notificationId, channel, state) {
    const col = channel === 'email' ? 'delivery_email' : 'delivery_in_app';
    db.run(`UPDATE notifications SET ${col} = ?, updated_at = ? WHERE id = ?`, state, clock.now(), notificationId);
  }

  function rollup(notificationId) {
    const jobs = db.all('SELECT step_type, status FROM jobs WHERE notification_id = ?', notificationId);
    const has = (s) => jobs.some((j) => j.status === s);
    const delivery = jobs.filter((j) => j.step_type !== 'digest');
    let status;
    if (jobs.length && jobs.every((j) => j.status === 'merged')) status = 'digested';
    else if (jobs.some((j) => UNFINISHED.includes(j.status))) {
      status = jobs.every((j) => ['pending', 'queued', 'delayed'].includes(j.status)) ? 'pending' : 'processing';
    } else if (has('deferred')) status = 'held';
    else if (has('summarized')) status = 'summarized';
    else if (jobs.length && jobs.every((j) => j.status === 'canceled')) status = 'canceled';
    else {
      const failed = delivery.filter((j) => j.status === 'failed').length;
      const done = delivery.filter((j) => j.status === 'completed').length;
      if (failed && done) status = 'partially_sent';
      else if (failed) status = 'failed';
      else status = 'sent';
    }
    db.run('UPDATE notifications SET status = ?, updated_at = ? WHERE id = ?', status, clock.now(), notificationId);
    return status;
  }

  /** Unblock the next step of the chain once this one is finished (done, skipped, failed or deferred). */
  function advance(job) {
    const next = db.get('SELECT * FROM jobs WHERE notification_id = ? AND step_index = ?', job.notification_id, job.step_index + 1);
    if (next && next.status === 'pending') {
      db.run(`UPDATE jobs SET status = 'queued', run_at = ?, updated_at = ? WHERE id = ?`, clock.now(), clock.now(), next.id);
    }
    rollup(job.notification_id);
  }

  function finishJob(jobId, status, extra = {}) {
    const now = clock.now();
    db.run(
      `UPDATE jobs SET status = ?, completed_at = ?, locked_at = NULL, last_error = ?, updated_at = ? WHERE id = ?`,
      status, now, extra.error ?? null, now, jobId,
    );
  }

  // ---------------------------------------------------------------- digest

  function enterDigest(job, step, payload, windowStart) {
    const digestKey = step.digestKey || '';
    const digestValue = step.digestKey ? String(payload[step.digestKey] ?? '') : '';
    // Default scope is the workflow itself; a named group lets several workflows share one digest (G8).
    const digestScope = step.groupScope ? `group:${step.groupScope}` : `workflow:${job.workflow_id}`;
    const notification = getNotification(job.notification_id);
    const entry = {
      transactionId: job.transaction_id, notificationId: job.notification_id, workflowId: job.workflow_id, at: clock.now(), payload,
    };

    for (let tries = 0; tries < 5; tries += 1) {
      const now = clock.now();
      const master = db.get(
        `SELECT * FROM jobs WHERE step_type = 'digest' AND status = 'delayed' AND subscriber_id = ?
           AND digest_scope = ? AND digest_key = ? AND digest_value = ?`,
        job.subscriber_id, digestScope, digestKey, digestValue,
      );
      if (master && master.run_at <= now) {
        // Window already closed but the worker has not released it yet: release it, start a new window.
        db.run(`UPDATE jobs SET status = 'queued', run_at = ?, updated_at = ? WHERE id = ?`, now, now, master.id);
        ctx.activity.log({
          transactionId: master.transaction_id, notificationId: master.notification_id, jobId: master.id,
          subscriberId: master.subscriber_id, workflowId: master.workflow_id, stepType: 'digest',
          event: 'digest_emitted', status: 'success', message: 'Digest window closed',
        });
        continue;
      }
      if (master) {
        const events = parseJson(master.digest_events, []);
        events.push(entry);
        db.run('UPDATE jobs SET digest_events = ?, updated_at = ? WHERE id = ?', JSON.stringify(events), now, master.id);
        db.run(
          `UPDATE jobs SET status = 'merged', master_job_id = ?, digest_scope = ?, digest_key = ?, digest_value = ?, updated_at = ?
           WHERE id = ?`,
          master.id, digestScope, digestKey, digestValue, now, job.id,
        );
        db.run(`UPDATE jobs SET status = 'merged', master_job_id = ?, updated_at = ? WHERE notification_id = ? AND step_index > ?`,
          master.id, now, job.notification_id, job.step_index);
        rollup(job.notification_id);
        ctx.activity.log({
          transactionId: job.transaction_id, notificationId: job.notification_id, jobId: job.id,
          subscriberId: job.subscriber_id, workflowId: job.workflow_id, stepType: 'digest', event: 'digest_merged',
          status: 'success', message: `Merged into digest master job ${master.id}`,
        });
        return 'merged';
      }
      try {
        db.run(
          `UPDATE jobs SET status = 'delayed', digest_scope = ?, digest_key = ?, digest_value = ?, digest_events = ?, run_at = ?,
             updated_at = ? WHERE id = ?`,
          digestScope, digestKey, digestValue, JSON.stringify([entry]), windowStart + step.windowMs, now, job.id,
        );
        rollup(job.notification_id);
        ctx.activity.log({
          transactionId: job.transaction_id, notificationId: notification.id, jobId: job.id,
          subscriberId: job.subscriber_id, workflowId: job.workflow_id, stepType: 'digest',
          event: 'digest_master_created', status: 'success',
          message: `Digest master created (${Math.round(step.windowMs / 1000)}s window)`,
        });
        return 'master';
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Another writer became master between our lookup and update; loop and merge into it.
      }
    }
    throw new Error('digest grouping did not converge');
  }

  function releaseDueDigests() {
    const now = clock.now();
    const due = db.all(`SELECT * FROM jobs WHERE step_type = 'digest' AND status = 'delayed' AND run_at <= ?`, now);
    for (const m of due) {
      db.run(`UPDATE jobs SET status = 'queued', run_at = ?, updated_at = ? WHERE id = ? AND status = 'delayed'`, now, now, m.id);
      const count = parseJson(m.digest_events, []).length;
      ctx.activity.log({
        transactionId: m.transaction_id, notificationId: m.notification_id, jobId: m.id, subscriberId: m.subscriber_id,
        workflowId: m.workflow_id, stepType: 'digest', event: 'digest_emitted', status: 'success',
        message: `Digest window closed; ${count} event(s) aggregated`,
      });
    }
    return due.length;
  }

  // ---------------------------------------------------------- notification

  /**
   * Create the notification and its whole job chain. Idempotent per (event, subscriber): replaying a
   * fan-out chunk returns the existing id and creates nothing.
   */
  function createNotification({ event, workflow, subscriber, payload, bypassFocus, ignoreMutes }) {
    const now = clock.now();
    const inserted = db.run(
      `INSERT INTO notifications (event_id, transaction_id, workflow_id, subscriber_id, payload, bypass_focus,
         ignore_mutes, correlation_value, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?, 'pending', ?, ?)
       ON CONFLICT(event_id, subscriber_id) DO NOTHING`,
      event.id, event.transaction_id, workflow.id, subscriber.id, JSON.stringify(payload), bypassFocus ? 1 : 0,
      ignoreMutes ? 1 : 0, ctx.workflows.correlationValue(workflow, payload), now, now,
    );
    const notification = db.get('SELECT * FROM notifications WHERE event_id = ? AND subscriber_id = ?', event.id, subscriber.id);
    if (inserted.changes === 0) return notification.id;

    let parentId = null;
    let firstJob = null;
    workflow.steps.forEach((step, index) => {
      const r = db.run(
        `INSERT INTO jobs (notification_id, parent_job_id, step_index, step_type, status, subscriber_id, workflow_id,
           transaction_id, max_attempts, idempotency_key, created_at, updated_at)
         VALUES (?,?,?,?, 'pending', ?,?,?,?,?,?,?)`,
        notification.id, parentId, index, step.type, subscriber.id, workflow.id, event.transaction_id,
        step.type === 'digest' ? 1 : maxDeliveryAttempts(), idempotencyKey(notification.id, index, step.type), now, now,
      );
      parentId = Number(r.lastInsertRowid);
      if (index === 0) firstJob = getJob(parentId);
    });

    const first = workflow.steps[0];
    if (first.type === 'digest') {
      enterDigest(firstJob, first, payload, event.created_at);
    } else {
      db.run(`UPDATE jobs SET status = 'queued', run_at = ?, updated_at = ? WHERE id = ?`, now, now, firstJob.id);
      rollup(notification.id);
    }
    return notification.id;
  }

  // -------------------------------------------------------------- execution

  /** Events this delivery covers: the digest's aggregated entries, or just the notification itself. */
  function eventsFor(notification) {
    const digest = db.get(`SELECT digest_events FROM jobs WHERE notification_id = ? AND step_type = 'digest'`, notification.id);
    const events = digest && digest.digest_events ? parseJson(digest.digest_events, []) : [];
    return events.length
      ? events.map((e) => ({ payload: e.payload, workflowId: e.workflowId ?? notification.workflow_id }))
      : [{ payload: parseJson(notification.payload, {}), workflowId: notification.workflow_id }];
  }

  function render(step, entries) {
    if (entries.length === 1) {
      const p = entries[0].payload;
      return { subject: renderTemplate(step.subject, p), body: renderTemplate(step.body, p) };
    }
    // A cross-workflow digest renders each event with its own workflow's template and labels it.
    const cache = new Map();
    const workflowOf = (id) => {
      if (!cache.has(id)) cache.set(id, ctx.workflows.getById(id));
      return cache.get(id);
    };
    const mixed = new Set(entries.map((e) => e.workflowId)).size > 1;
    const latest = entries[entries.length - 1].payload;
    return {
      subject: `${entries.length} updates: ${renderTemplate(step.subject, latest)}`,
      body: entries.map((e, i) => {
        const wf = workflowOf(e.workflowId);
        const own = (wf && wf.steps.find((s) => s.type === step.type)) || step;
        const label = mixed && wf ? `[${wf.identifier}] ` : '';
        return `${i + 1}. ${label}${renderTemplate(own.body, e.payload)}`;
      }).join('\n'),
    };
  }

  function claimNext(now, preferId = null) {
    const staleBefore = now - config.jobLockTimeoutMs;
    const where = `(status = 'queued') OR (status = 'retrying' AND next_retry_at <= ?) OR (status = 'running' AND locked_at <= ?)`;
    // Three index-backed lookups instead of one OR query, so claiming stays O(log n) at 30k+ jobs.
    // A just-unblocked next step of the chain we finished goes first (depth-first: a student's in-app
    // message does not wait behind every other student's email). Then crash-recovered work, due
    // retries, and the queue in arrival order.
    const candidate = (preferId && db.get(`SELECT id FROM jobs WHERE id = ? AND status = 'queued'`, preferId))
      || db.get(`SELECT id FROM jobs WHERE status = 'running' AND locked_at <= ? LIMIT 1`, staleBefore)
      || db.get(`SELECT id FROM jobs WHERE status = 'retrying' AND next_retry_at <= ? ORDER BY next_retry_at LIMIT 1`, now)
      || db.get(`SELECT id FROM jobs WHERE status = 'queued' ORDER BY run_at, id LIMIT 1`);
    if (!candidate) return null;
    const claimed = db.run(
      `UPDATE jobs SET status = 'running', locked_at = ?, attempts = attempts + 1,
         started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ? AND (${where})`,
      now, now, now, candidate.id, now, staleBefore,
    );
    return claimed.changes === 1 ? getJob(candidate.id) : { retry: true };
  }

  function recordAttempt(job, channel, status, fields = {}) {
    db.run(
      `INSERT INTO delivery_attempts (job_id, attempt_no, channel, status, started_at) VALUES (?,?,?,?,?)
       ON CONFLICT(job_id, attempt_no) DO NOTHING`,
      job.id, job.attempts, channel, 'started', clock.now(),
    );
    if (status !== 'started') {
      db.run(
        `UPDATE delivery_attempts SET status = ?, error = ?, transient = ?, provider_message_id = ?, finished_at = ?
         WHERE job_id = ? AND attempt_no = ?`,
        status, fields.error ?? null, fields.transient == null ? null : (fields.transient ? 1 : 0),
        fields.providerMessageId ?? null, clock.now(), job.id, job.attempts,
      );
    }
  }

  const log = (job, extra) => ctx.activity.log({
    transactionId: job.transaction_id, notificationId: job.notification_id, jobId: job.id,
    subscriberId: job.subscriber_id, workflowId: job.workflow_id, stepType: job.step_type,
    attempt: job.attempts, ...extra,
  });

  /**
   * Park a permanently failed job in the dead-letter queue (G7), in the same transaction that failed it.
   * One row per job: a job that fails again after an operator retry re-opens its existing letter.
   */
  function deadLetter(job, channel, reason, error) {
    const now = clock.now();
    db.run(
      `INSERT INTO dead_letters (job_id, notification_id, subscriber_id, workflow_id, transaction_id, channel, reason,
         last_error, attempts, status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?, 'open', ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET status = 'open', reason = excluded.reason, last_error = excluded.last_error,
         attempts = excluded.attempts, updated_at = excluded.updated_at, resolved_at = NULL`,
      job.id, job.notification_id, job.subscriber_id, job.workflow_id, job.transaction_id, channel, reason,
      error ?? null, job.attempts, now, now,
    );
    log(job, { event: 'dead_lettered', status: 'failure', message: `Moved to dead-letter queue (${reason})`, error });
  }

  /** Record a failed try: schedule a bounded retry for transient errors, otherwise fail and move on. */
  function recordFailure(job, channel, err, transient) {
    const label = channel === 'email' ? 'email' : 'inapp';
    const message = err.message || String(err);
    db.tx(() => {
      recordAttempt(job, channel, 'failed', { error: message, transient });
      if (transient && job.attempts < job.max_attempts) {
        const delays = config.emailBackoffMs;
        const delay = delays[Math.min(job.attempts - 1, delays.length - 1)];
        const now = clock.now();
        db.run(
          `UPDATE jobs SET status = 'retrying', next_retry_at = ?, last_error = ?, locked_at = NULL, updated_at = ? WHERE id = ?`,
          now + delay, message, now, job.id,
        );
        setDelivery(job.notification_id, channel, 'retrying');
        rollup(job.notification_id);
        log(job, { event: `${label}_failed`, status: 'failure', message: `Attempt ${job.attempts} failed: ${message}`, error: message });
        log(job, { event: 'retry_scheduled', status: 'info', message: `Retry ${job.attempts + 1}/${job.max_attempts} in ${delay}ms` });
      } else {
        finishJob(job.id, 'failed', { error: message });
        setDelivery(job.notification_id, channel, 'failed');
        log(job, { event: `${label}_failed`, status: 'failure', message: `Attempt ${job.attempts} failed: ${message}`, error: message });
        log(job, {
          event: 'delivery_failed', status: 'failure',
          message: transient ? 'Gave up after max attempts' : 'Permanent error; not retrying', error: message,
        });
        deadLetter(job, channel, transient ? 'attempts_exhausted' : 'permanent_error', message);
        advance(job);
      }
    });
    logger.warn('delivery attempt failed', { jobId: job.id, channel, attempt: job.attempts, transient, error: message });
  }

  function deliverInApp(job, notification, step) {
    const payloads = eventsFor(notification);
    const { subject, body } = render(step, payloads);
    db.tx(() => {
      const now = clock.now();
      db.run(
        `INSERT INTO messages (notification_id, job_id, subscriber_id, channel, subject, content, idempotency_key,
           status, created_at, updated_at)
         VALUES (?,?,?, 'in-app', ?,?,?, 'sent', ?, ?)
         ON CONFLICT(subscriber_id, channel, idempotency_key) DO UPDATE SET
           subject = excluded.subject, content = excluded.content, seen = 0, updated_at = excluded.updated_at`,
        notification.id, job.id, job.subscriber_id, subject, body, job.idempotency_key, now, now,
      );
      recordAttempt(job, 'in-app', 'success');
      finishJob(job.id, 'completed');
      setDelivery(notification.id, 'in-app', 'sent');
      log(job, { event: 'inapp_created', status: 'success', message: 'In-app message created' });
      advance(job);
    });
    const sub = db.get('SELECT external_id FROM subscribers WHERE id = ?', job.subscriber_id);
    ctx.bus.emit('in-app', { subscriberId: sub.external_id, subject, body, notificationId: notification.id });
  }

  async function deliverEmail(job, notification, subscriber, step) {
    const already = db.get(
      `SELECT id FROM messages WHERE subscriber_id = ? AND channel = 'email' AND idempotency_key = ?`,
      job.subscriber_id, job.idempotency_key,
    );
    if (already) {
      // A previous run already delivered this exact logical email (e.g. crash before status was saved).
      db.tx(() => {
        recordAttempt(job, 'email', 'success');
        finishJob(job.id, 'completed');
        setDelivery(notification.id, 'email', 'sent');
        log(job, { event: 'email_deduplicated', status: 'success', message: 'Message already recorded for idempotency key; provider not called' });
        advance(job);
      });
      return;
    }
    if (!subscriber.email) {
      recordFailure(job, 'email', new Error('Subscriber has no email address'), false);
      return;
    }
    const { subject, body } = render(step, eventsFor(notification));
    const gate = ctx.providerGuard.acquire();
    if (!gate.ok) {
      // Throttled or circuit open: the provider was not called, so this try does not count (G6).
      db.tx(() => {
        db.run(
          `UPDATE jobs SET status = 'retrying', attempts = attempts - 1, next_retry_at = ?, locked_at = NULL, updated_at = ?
           WHERE id = ?`,
          gate.retryAt, clock.now(), job.id,
        );
        rollup(job.notification_id);
        log(job, {
          event: gate.reason === 'throttled' ? 'provider_throttled' : 'circuit_open', status: 'info',
          attempt: job.attempts - 1,
          message: `${gate.reason === 'throttled' ? 'Provider rate limit' : 'Provider circuit open'}; rescheduled without using an attempt`,
        });
      });
      return;
    }
    db.tx(() => recordAttempt(job, 'email', 'started'));
    let result;
    try {
      result = await ctx.emailProvider.send({
        to: subscriber.email, subject, body, idempotencyKey: job.idempotency_key, from: config.smtp.from,
      });
    } catch (err) {
      const transient = err instanceof ProviderError ? err.transient : true;
      ctx.providerGuard.onFailure({ message: err.message, transient, status: err.status, retryAfterMs: err.retryAfterMs });
      recordFailure(job, 'email', err, transient);
      return;
    }
    ctx.providerGuard.onSuccess();
    db.tx(() => {
      const now = clock.now();
      db.run(
        `INSERT INTO messages (notification_id, job_id, subscriber_id, channel, subject, content, recipient_email,
           provider_message_id, idempotency_key, status, created_at, updated_at)
         VALUES (?,?,?, 'email', ?,?,?,?,?, 'sent', ?, ?)
         ON CONFLICT(subscriber_id, channel, idempotency_key) DO UPDATE SET
           provider_message_id = excluded.provider_message_id, status = 'sent', updated_at = excluded.updated_at`,
        notification.id, job.id, job.subscriber_id, subject, body, subscriber.email, result.providerMessageId,
        job.idempotency_key, now, now,
      );
      recordAttempt(job, 'email', 'success', { providerMessageId: result.providerMessageId });
      finishJob(job.id, 'completed');
      setDelivery(notification.id, 'email', 'sent');
      log(job, {
        event: 'email_sent', status: 'success',
        message: `Email sent to ${subscriber.email} (provider id: ${result.providerMessageId})`,
      });
      advance(job);
    });
  }

  function skipStep(job, notification, channel, reason) {
    db.tx(() => {
      finishJob(job.id, 'skipped');
      setDelivery(notification.id, channel, 'skipped');
      log(job, { event: 'step_skipped', status: 'skipped', message: reason });
      advance(job);
    });
  }

  async function executeDelivery(job, notification, subscriber, workflow, step) {
    const channel = job.step_type;
    const prefs = ctx.subscribers.resolve(subscriber.id, workflow);
    const enabled = notification.ignore_mutes ? true : (channel === 'email' ? prefs.email : prefs.inApp);
    if (!enabled) {
      skipStep(job, notification, channel, `${channel} muted by subscriber preference`);
      return;
    }
    if (!notification.bypass_focus) {
      const session = ctx.focus.activeSession(subscriber.id, clock.now());
      if (session) {
        db.tx(() => {
          ctx.focus.hold(session, notification);
          finishJob(job.id, 'deferred');
          setDelivery(notification.id, channel, 'deferred');
          log(job, { event: 'step_deferred', status: 'info', message: 'Held by Focus Mode until the session ends' });
          advance(job);
        });
        return;
      }
    } else {
      const session = ctx.focus.activeSession(subscriber.id, clock.now());
      if (session) {
        const first = ctx.focus.recordBypass(session, notification);
        if (first) log(job, { event: 'focus_bypassed', status: 'info', message: 'Critical notification bypassed Focus Mode' });
      }
    }
    if (channel === 'email') await deliverEmail(job, notification, subscriber, step);
    else deliverInApp(job, notification, step);
  }

  async function execute(job) {
    const notification = getNotification(job.notification_id);
    const workflow = ctx.workflows.getById(job.workflow_id);
    const subscriber = db.get('SELECT * FROM subscribers WHERE id = ?', job.subscriber_id);
    const step = workflow && workflow.steps[job.step_index];
    if (!notification || !subscriber || !step || step.type !== job.step_type) {
      db.tx(() => {
        finishJob(job.id, 'failed', { error: 'workflow, step or subscriber no longer available' });
        log(job, { event: 'delivery_failed', status: 'failure', message: 'Job could not be rehydrated', error: 'rehydrate_failed' });
        if (job.step_type !== 'digest') deadLetter(job, job.step_type, 'rehydrate_failed', 'workflow, step or subscriber no longer available');
        rollup(job.notification_id);
      });
      return;
    }
    if (job.attempts > job.max_attempts && job.step_type !== 'digest') {
      // Reclaimed after crashes more often than the attempt budget allows.
      db.tx(() => {
        finishJob(job.id, 'failed', { error: 'attempt budget exhausted' });
        setDelivery(job.notification_id, job.step_type, 'failed');
        log(job, { event: 'delivery_failed', status: 'failure', message: 'Attempt budget exhausted', error: 'attempts_exhausted' });
        deadLetter(job, job.step_type, 'attempts_exhausted', 'attempt budget exhausted after repeated crashes');
        advance(job);
      });
      return;
    }
    if (job.step_type === 'digest') {
      db.tx(() => {
        finishJob(job.id, 'completed');
        advance(job);
      });
      return;
    }
    try {
      await executeDelivery(job, notification, subscriber, workflow, step);
    } catch (err) {
      // Anything unexpected (preference lookup, DB error): count it as a failed transient attempt.
      logger.error('job execution error', { jobId: job.id, error: err.message });
      try {
        recordFailure(getJob(job.id), job.step_type, err, true);
      } catch (inner) {
        // Database unavailable: leave the job 'running'; it is reclaimed after the lock timeout.
        logger.error('could not record job failure; lock timeout will reclaim it', { jobId: job.id, error: inner.message });
      }
    }
  }

  async function runDueJobs() {
    let ran = 0;
    let follow = null;
    for (;;) {
      const job = claimNext(clock.now(), follow);
      if (!job) break;
      if (job.retry) { follow = null; continue; }
      await execute(job);
      const next = db.get(`SELECT id FROM jobs WHERE notification_id = ? AND step_index = ? AND status = 'queued'`,
        job.notification_id, job.step_index + 1);
      follow = next ? next.id : null;
      ran += 1;
      if (ran > 1000000) break;
    }
    return ran;
  }

  // ----------------------------------------------------------------- cancel

  function stripFromMaster(masterId, transactionId) {
    const master = getJob(masterId);
    if (!master || master.status !== 'delayed') return;
    const remaining = parseJson(master.digest_events, []).filter((e) => e.transactionId !== transactionId);
    db.run('UPDATE jobs SET digest_events = ?, updated_at = ? WHERE id = ?', JSON.stringify(remaining), clock.now(), master.id);
  }

  function cancelTransaction(transactionId) {
    const event = db.get('SELECT * FROM events WHERE transaction_id = ?', transactionId);
    if (!event) return null;
    return db.tx(() => {
      const now = clock.now();
      if (['pending', 'processing'].includes(event.status)) {
        db.run(`UPDATE events SET status = 'canceled', updated_at = ? WHERE id = ?`, now, event.id);
      }
      const touched = new Set();
      const retained = new Set(); // notifications whose digest master stays alive for other events
      let canceled = 0;
      const jobs = db.all(
        `SELECT * FROM jobs WHERE transaction_id = ? AND status IN ('pending','queued','delayed','retrying','merged') ORDER BY id`,
        transactionId,
      );
      for (const job of jobs) {
        if (retained.has(job.notification_id)) continue;
        if (job.status === 'merged' && job.master_job_id) stripFromMaster(job.master_job_id, transactionId);
        if (job.step_type === 'digest' && job.status === 'delayed') {
          const remaining = parseJson(job.digest_events, []).filter((e) => e.transactionId !== transactionId);
          if (remaining.length > 0) {
            // Other transactions are merged into this master; keep it alive for them, drop only our event.
            db.run('UPDATE jobs SET digest_events = ?, updated_at = ? WHERE id = ?', JSON.stringify(remaining), now, job.id);
            retained.add(job.notification_id);
            continue;
          }
        }
        db.run(`UPDATE jobs SET status = 'canceled', locked_at = NULL, updated_at = ? WHERE id = ?`, now, job.id);
        canceled += 1;
        touched.add(job.notification_id);
      }
      for (const nid of touched) rollup(nid);
      ctx.activity.log({
        transactionId, event: 'event_canceled', status: 'success', message: `${canceled} pending job(s) canceled`,
      });
      return { canceledJobCount: canceled };
    });
  }

  return {
    idempotencyKey, createNotification, releaseDueDigests, runDueJobs, cancelTransaction, rollup, advance, setDelivery,
  };
}

module.exports = { createPipeline };
