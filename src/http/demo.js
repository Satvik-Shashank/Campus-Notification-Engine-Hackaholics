'use strict';

const crypto = require('node:crypto');
const { HttpError, toIso } = require('../util');

/**
 * Demo Lab support, mounted ONLY when DEMO_MODE=true (and the config guard refuses DEMO_MODE in
 * production). Nothing here fakes a result: it injects provider faults, fires real HTTP webhook
 * requests at this server, and reads real rows back so the UI can show a verdict.
 */
function mountDemoRoutes(app, ctx, apiKey) {
  const { db } = ctx;

  app.get('/admin/demo', apiKey, (_req, res) => {
    res.json({ demoMode: true, pendingFaults: ctx.faults.pending(), inboxSessionAuth: ctx.config.inboxSessionAuth });
  });

  app.post('/admin/demo/provider-fail', apiKey, (req, res) => {
    const { count = 1, kind = 'transient' } = req.body || {};
    if (!Number.isInteger(count) || count < 0 || count > 50) throw new HttpError(400, 'BadRequest', 'count must be 0..50.');
    if (!['transient', 'permanent'].includes(kind)) throw new HttpError(400, 'BadRequest', 'kind must be transient or permanent.');
    if (count === 0) ctx.faults.clear();
    else ctx.faults.arm(count, kind);
    res.json({ pendingFaults: ctx.faults.pending() });
  });

  /** Real DB state for a set of transactions, so the Demo Lab verdicts come from rows, not from the UI. */
  app.get('/admin/demo/inspect', apiKey, (req, res) => {
    const ids = String(req.query.transactionIds || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0 || ids.length > 200) throw new HttpError(400, 'BadRequest', 'transactionIds: 1..200 comma-separated ids.');
    const marks = ids.map(() => '?').join(',');
    const notifications = db.all(
      `SELECT n.id, n.transaction_id, s.external_id AS subscriber, n.status, n.delivery_email, n.delivery_in_app
         FROM notifications n JOIN subscribers s ON s.id = n.subscriber_id WHERE n.transaction_id IN (${marks}) ORDER BY n.id`, ...ids,
    );
    const nids = notifications.map((n) => n.id);
    const nm = nids.map(() => '?').join(',') || 'NULL';
    const messages = db.all(
      `SELECT m.id, m.channel, m.subject, m.content, m.idempotency_key, m.provider_message_id, m.provider_status, n.transaction_id
         FROM messages m JOIN notifications n ON n.id = m.notification_id WHERE m.notification_id IN (${nm}) ORDER BY m.id`, ...nids,
    );
    const attempts = db.all(
      `SELECT a.attempt_no, a.channel, a.status, a.error, a.provider_message_id, j.idempotency_key, j.transaction_id, a.started_at
         FROM delivery_attempts a JOIN jobs j ON j.id = a.job_id WHERE j.notification_id IN (${nm}) ORDER BY a.id`, ...nids,
    );
    const jobs = db.all(
      `SELECT step_type, status, COUNT(*) AS n FROM jobs WHERE notification_id IN (${nm}) GROUP BY step_type, status`, ...nids,
    );
    const deadLetters = db.all(`SELECT id, channel, reason, status, transaction_id FROM dead_letters WHERE transaction_id IN (${marks})`, ...ids);
    res.json({
      notifications: notifications.map((n) => ({
        transactionId: n.transaction_id, subscriberId: n.subscriber, status: n.status, email: n.delivery_email, inApp: n.delivery_in_app,
      })),
      messages: messages.map((m) => ({
        id: m.id, channel: m.channel, transactionId: m.transaction_id, subject: m.subject, content: m.content,
        idempotencyKey: m.idempotency_key, providerMessageId: m.provider_message_id, providerStatus: m.provider_status,
      })),
      attempts: attempts.map((a) => ({
        transactionId: a.transaction_id, channel: a.channel, attemptNo: a.attempt_no, status: a.status, error: a.error,
        idempotencyKey: a.idempotency_key, providerMessageId: a.provider_message_id, at: toIso(a.started_at),
      })),
      jobs,
      deadLetters,
    });
  });

  /**
   * Fires four real HTTP requests at this server's /webhooks endpoint: valid signature, wrong
   * signature, no signature, and a provider without a verifier. Returns the actual status codes and
   * whether the target message's provider_status changed.
   */
  app.post('/admin/demo/webhook-check', apiKey, async (req, res, next) => {
    try {
      const target = db.get(`SELECT id, provider_message_id FROM messages WHERE channel = 'email' AND provider_message_id IS NOT NULL
                              ORDER BY id DESC LIMIT 1`);
      if (!target) throw new HttpError(409, 'Conflict', 'Send at least one email first (any Killer Test run will do).');
      const base = `http://127.0.0.1:${req.socket.localPort}`;
      const secret = ctx.config.webhookSecrets.generic;
      const statusOf = () => db.get('SELECT provider_status FROM messages WHERE id = ?', target.id).provider_status;
      db.run('UPDATE messages SET provider_status = NULL WHERE id = ?', target.id);

      const cases = [
        { name: 'forged signature', provider: 'generic', event: 'bounce', sign: () => 'sha256=' + crypto.randomBytes(32).toString('hex') },
        { name: 'missing signature', provider: 'generic', event: 'bounce', sign: () => null },
        { name: 'provider without a verifier (sendgrid)', provider: 'sendgrid', event: 'bounce', sign: () => null },
        {
          name: 'valid signature', provider: 'generic', event: 'delivered',
          sign: (raw) => 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex'),
        },
      ];
      const results = [];
      for (const c of cases) {
        const raw = JSON.stringify({ event: c.event, messageId: target.provider_message_id });
        const headers = { 'content-type': 'application/json' };
        const sig = c.sign(raw);
        if (sig) headers['x-webhook-signature'] = sig;
        const before = statusOf();
        const r = await fetch(`${base}/webhooks/${c.provider}`, { method: 'POST', headers, body: raw });
        const body = await r.json().catch(() => ({}));
        results.push({
          case: c.name, httpStatus: r.status, verification: body.verification || (body.verified ? 'valid' : null),
          claimedEvent: c.event, providerStatusBefore: before, providerStatusAfter: statusOf(),
        });
      }
      res.json({ messageId: target.provider_message_id, results });
    } catch (err) {
      next(err);
    }
  });

  /** Latest activity rows for a list of transactions (Demo Lab live timeline). */
  app.get('/admin/demo/timeline', apiKey, (req, res) => {
    const ids = String(req.query.transactionIds || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 200);
    if (!ids.length) throw new HttpError(400, 'BadRequest', 'transactionIds required.');
    const rows = db.all(
      `SELECT a.*, s.external_id AS sub FROM activity_log a LEFT JOIN subscribers s ON s.id = a.subscriber_id
        WHERE a.transaction_id IN (${ids.map(() => '?').join(',')}) ORDER BY a.id`, ...ids,
    );
    res.json({
      events: rows.map((r) => ({
        id: r.id, at: toIso(r.created_at), transactionId: r.transaction_id, event: r.event, status: r.status,
        stepType: r.step_type, attempt: r.attempt, subscriberId: r.sub, details: r.message, error: r.error,
      })),
    });
  });

}

module.exports = { mountDemoRoutes };
