'use strict';

const { HttpError, toIso, parseJson } = require('../util');
const { PROVIDERS } = require('../engine/webhooks');

const page = (q, def = 50, max = 500) => ({
  limit: Math.min(Math.max(Number.parseInt(q.limit ?? String(def), 10) || def, 1), max),
  offset: Math.max(Number.parseInt(q.offset ?? '0', 10) || 0, 0),
});

/**
 * Read-mostly endpoints that feed the Operator Console. All require the API key. They are additive:
 * nothing here changes an endpoint documented in docs/API.md.
 */
function mountConsoleRoutes(app, ctx, apiKey) {
  const { db, clock } = ctx;

  app.get('/admin/stats', apiKey, (_req, res) => {
    const now = clock.now();
    const since = now - 24 * 3600 * 1000;
    const count = (sql, ...p) => db.get(sql, ...p).n;
    const byStatus = Object.fromEntries(
      db.all('SELECT status, COUNT(*) AS n FROM notifications WHERE created_at >= ? GROUP BY status', since).map((r) => [r.status, r.n]),
    );
    const channel = (col) => Object.fromEntries(
      db.all(`SELECT ${col} AS s, COUNT(*) AS n FROM notifications WHERE created_at >= ? GROUP BY ${col}`, since).map((r) => [r.s, r.n]),
    );
    const hourly = [];
    for (let i = 23; i >= 0; i -= 1) {
      const from = now - (i + 1) * 3600 * 1000;
      const to = now - i * 3600 * 1000;
      hourly.push({
        hourEnding: toIso(to),
        events: count('SELECT COUNT(*) AS n FROM events WHERE created_at > ? AND created_at <= ?', from, to),
        messages: count('SELECT COUNT(*) AS n FROM messages WHERE created_at > ? AND created_at <= ?', from, to),
      });
    }
    res.json({
      window: '24h',
      events: count('SELECT COUNT(*) AS n FROM events WHERE created_at >= ?', since),
      notifications: byStatus,
      email: channel('delivery_email'),
      inApp: channel('delivery_in_app'),
      messages: count('SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?', since),
      deadLettersOpen: ctx.deadLetters.countOpen(),
      queue: Object.fromEntries(
        db.all(`SELECT status, COUNT(*) AS n FROM jobs WHERE status IN ('queued','running','retrying','delayed') GROUP BY status`)
          .map((r) => [r.status, r.n]),
      ),
      subscribers: count('SELECT COUNT(*) AS n FROM subscribers'),
      activeFocusSessions: count(`SELECT COUNT(*) AS n FROM focus_sessions WHERE status = 'active'`),
      provider: ctx.providerGuard.snapshot().breaker.state,
      hourly,
    });
  });

  app.get('/admin/events', apiKey, (req, res) => {
    const { limit, offset } = page(req.query);
    const where = [`w.identifier NOT LIKE '\\_\\_%' ESCAPE '\\'`];
    const params = [];
    if (req.query.q) { where.push('e.transaction_id LIKE ?'); params.push(`%${req.query.q}%`); }
    if (req.query.workflowId) { where.push('w.identifier = ?'); params.push(req.query.workflowId); }
    const w = `WHERE ${where.join(' AND ')}`;
    const total = db.get(`SELECT COUNT(*) AS n FROM events e JOIN workflows w ON w.id = e.workflow_id ${w}`, ...params).n;
    const rows = db.all(
      `SELECT e.*, w.identifier AS wf FROM events e JOIN workflows w ON w.id = e.workflow_id ${w}
       ORDER BY e.id DESC LIMIT ? OFFSET ?`, ...params, limit, offset,
    );
    res.json({
      total,
      events: rows.map((e) => {
        const st = Object.fromEntries(db.all('SELECT status, COUNT(*) AS n FROM notifications WHERE event_id = ? GROUP BY status', e.id)
          .map((r) => [r.status, r.n]));
        return {
          transactionId: e.transaction_id, workflowId: e.wf, status: e.status, priority: e.priority,
          recipientType: e.recipient_type, recipientCount: e.recipient_count, attempts: e.attempts, lastError: e.last_error,
          submittedAt: toIso(e.created_at), notifications: st, payload: parseJson(e.payload, {}),
        };
      }),
    });
  });

  app.get('/admin/subscribers', apiKey, (req, res) => {
    const { limit, offset } = page(req.query, 50, 1000);
    const params = [];
    let w = '';
    if (req.query.q) { w = 'WHERE external_id LIKE ? OR email LIKE ?'; params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
    const total = db.get(`SELECT COUNT(*) AS n FROM subscribers ${w}`, ...params).n;
    const rows = db.all(`SELECT * FROM subscribers ${w} ORDER BY id LIMIT ? OFFSET ?`, ...params, limit, offset);
    res.json({
      total,
      subscribers: rows.map((s) => ({
        subscriberId: s.external_id, email: s.email, firstName: s.first_name, lastName: s.last_name,
        topics: db.all('SELECT topic FROM topic_members WHERE subscriber_id = ? ORDER BY topic', s.id).map((r) => r.topic),
        createdAt: toIso(s.created_at),
      })),
    });
  });

  app.get('/admin/topics', apiKey, (_req, res) => {
    res.json({ topics: db.all('SELECT topic, COUNT(*) AS members FROM topic_members GROUP BY topic ORDER BY topic') });
  });

  app.get('/admin/providers', apiKey, (_req, res) => {
    res.json({ email: { provider: ctx.emailProvider.name, ...ctx.providerGuard.snapshot() } });
  });
  app.post('/admin/providers/email/reset', apiKey, (_req, res) => {
    ctx.providerGuard.reset();
    res.json({ status: 'reset', email: ctx.providerGuard.snapshot() });
  });

  app.get('/admin/webhooks', apiKey, (req, res) => {
    const { limit, offset } = page(req.query, 100);
    const rows = db.all('SELECT * FROM webhook_events ORDER BY id DESC LIMIT ? OFFSET ?', limit, offset);
    res.json({
      // Only whether a secret is set; the secret itself is never returned.
      providers: Object.entries(PROVIDERS).map(([name, scheme]) => ({
        provider: name, scheme: scheme || 'none (always rejected)', secretConfigured: !!ctx.config.webhookSecrets[name],
        allowUnverified: ctx.config.webhookAllowUnverified[name] === true,
      })),
      total: db.get('SELECT COUNT(*) AS n FROM webhook_events').n,
      webhooks: rows.map((r) => ({
        id: r.id, provider: r.provider, verification: r.verification, outcome: r.outcome, applied: r.applied,
        bodySha256: r.body_sha256, receivedAt: toIso(r.created_at),
      })),
    });
  });

  // ---- dead-letter queue (G7) ----
  const idParam = (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'BadRequest', 'id must be a positive integer.');
    return n;
  };
  app.get('/admin/dead-letters', apiKey, (req, res) => res.json(ctx.deadLetters.list(req.query)));
  app.post('/admin/dead-letters/retry', apiKey, (req, res) => res.json(ctx.deadLetters.retryTransaction((req.body || {}).transactionId)));
  app.post('/admin/dead-letters/:id/retry', apiKey, (req, res) => res.json(ctx.deadLetters.retry(idParam(req.params.id))));
  app.post('/admin/dead-letters/:id/dismiss', apiKey, (req, res) => res.json(ctx.deadLetters.dismiss(idParam(req.params.id))));
}

module.exports = { mountConsoleRoutes };
