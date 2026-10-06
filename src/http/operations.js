'use strict';

const { HttpError, parseJson, toIso } = require('../util');

/**
 * Operator read models: attention/engagement metrics and the per-student delivery lifecycle.
 * Everything is computed from the engine's own rows.
 */
function mountOperationsRoutes(app, ctx, { apiKey }) {
  const { db, clock } = ctx;

  app.get('/admin/insights', apiKey, (req, res) => {
    const days = Math.min(Math.max(Number.parseInt(req.query.days ?? '7', 10) || 7, 1), 90);
    const since = clock.now() - days * 24 * 3600 * 1000;
    const one = (sql, ...p) => db.get(sql, ...p).n || 0;
    const notifications = one('SELECT COUNT(*) AS n FROM notifications WHERE created_at >= ?', since);
    const digestedInto = one(`SELECT COUNT(*) AS n FROM notifications WHERE created_at >= ? AND status = 'digested'`, since);
    const combinedMasters = one(`SELECT COUNT(*) AS n FROM jobs j JOIN notifications n ON n.id = j.notification_id
      WHERE n.created_at >= ? AND j.step_type = 'digest' AND j.status = 'completed' AND json_array_length(j.digest_events) > 1`, since);
    const held = one(`SELECT COUNT(*) AS n FROM held_events WHERE disposition = 'held' AND created_at >= ?`, since);
    const bypassed = one(`SELECT COUNT(*) AS n FROM held_events WHERE disposition = 'bypassed' AND created_at >= ?`, since);
    const suppressed = db.all('SELECT content FROM focus_summaries WHERE created_at >= ?', since)
      .reduce((a, r) => { const c = parseJson(r.content, {}); return a + ((c.suppressed && (c.suppressed.acknowledged + c.suppressed.duplicates)) || 0); }, 0);
    const critical = one(`SELECT COUNT(*) AS n FROM notifications n JOIN events e ON e.id = n.event_id
      WHERE n.created_at >= ? AND (n.ignore_mutes = 1 OR e.priority = 'critical')`, since);
    const immediate = one(`SELECT COUNT(*) AS n FROM notifications n WHERE n.created_at >= ? AND n.status IN ('sent','partially_sent')
      AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.notification_id = n.id AND j.step_type = 'digest')`, since);
    const inApp = one(`SELECT COUNT(*) AS n FROM messages WHERE channel = 'in-app' AND created_at >= ?`, since);
    const read = one(`SELECT COUNT(*) AS n FROM messages WHERE channel = 'in-app' AND created_at >= ? AND seen = 1`, since);
    const clicked = one(`SELECT COUNT(*) AS n FROM messages WHERE channel = 'in-app' AND created_at >= ? AND clicked_at IS NOT NULL`, since);
    const emails = one(`SELECT COUNT(*) AS n FROM messages WHERE channel = 'email' AND created_at >= ?`, since);
    const skipped = one(`SELECT COUNT(*) AS n FROM notifications WHERE created_at >= ? AND delivery_email = 'skipped'`, since);
    const byCategory = db.all(`SELECT w.category AS category, COUNT(*) AS notifications,
        SUM(CASE WHEN m.seen = 1 THEN 1 ELSE 0 END) AS read
      FROM notifications n JOIN workflows w ON w.id = n.workflow_id
      LEFT JOIN messages m ON m.notification_id = n.id AND m.channel = 'in-app'
      WHERE n.created_at >= ? AND w.identifier NOT LIKE 'demo-%' AND w.identifier NOT LIKE '\\_\\_%' ESCAPE '\\'
      GROUP BY w.category ORDER BY notifications DESC`, since);
    const daily = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const to = clock.now() - i * 24 * 3600 * 1000;
      const from = to - 24 * 3600 * 1000;
      daily.push({
        dayEnding: toIso(to),
        notifications: one('SELECT COUNT(*) AS n FROM notifications WHERE created_at > ? AND created_at <= ?', from, to),
        delivered: one('SELECT COUNT(*) AS n FROM messages WHERE created_at > ? AND created_at <= ?', from, to),
      });
    }
    res.json({
      days,
      attention: { notifications, deliveredImmediately: immediate, combinedIntoDigests: digestedInto, digestsSent: combinedMasters, heldByFocus: held, criticalBypassedFocus: bypassed, suppressedAsRedundant: suppressed, critical },
      engagement: { inAppDelivered: inApp, read, clicked, readRate: inApp ? read / inApp : 0, clickRate: inApp ? clicked / inApp : 0 },
      channels: { inApp, email: emails, emailSkippedByPreference: skipped },
      byCategory: byCategory.map((r) => ({ category: r.category, notifications: r.notifications, read: r.read || 0 })),
      daily,
    });
  });

  /** Students reached by one event, with their per-channel state. */
  app.get('/admin/events/:transactionId/recipients', apiKey, (req, res) => {
    const where = ['n.transaction_id = ?'];
    const params = [req.params.transactionId];
    if (req.query.q) { where.push('(s.external_id LIKE ? OR s.first_name LIKE ? OR s.last_name LIKE ?)'); const l = `%${req.query.q}%`; params.push(l, l, l); }
    const rows = db.all(
      `SELECT n.id, n.status, n.delivery_email, n.delivery_in_app, s.external_id, s.first_name, s.last_name,
         (SELECT seen FROM messages m WHERE m.notification_id = n.id AND m.channel = 'in-app') AS seen
       FROM notifications n JOIN subscribers s ON s.id = n.subscriber_id WHERE ${where.join(' AND ')} ORDER BY n.id LIMIT 200`, ...params,
    );
    res.json({
      recipients: rows.map((r) => ({
        notificationId: r.id, subscriberId: r.external_id, name: [r.first_name, r.last_name].filter(Boolean).join(' '),
        status: r.status, email: r.delivery_email, inApp: r.delivery_in_app, read: r.seen === 1,
      })),
    });
  });

  /** The full lifecycle of one student's notification, stage by stage. */
  app.get('/admin/deliveries/:notificationId', apiKey, (req, res) => {
    const id = Number(req.params.notificationId);
    const n = Number.isInteger(id) && db.get(
      `SELECT n.*, s.external_id, s.first_name, s.last_name, w.name AS wf_name, w.identifier AS wf, e.created_at AS e_created,
         e.recipient_type, e.recipients, e.priority AS e_priority
       FROM notifications n JOIN subscribers s ON s.id = n.subscriber_id JOIN workflows w ON w.id = n.workflow_id
       JOIN events e ON e.id = n.event_id WHERE n.id = ?`, id,
    );
    if (!n) throw new HttpError(404, 'NotFound', 'Notification not found.');
    const jobs = db.all('SELECT * FROM jobs WHERE notification_id = ? ORDER BY step_index', id);
    const acts = db.all('SELECT * FROM activity_log WHERE notification_id = ? ORDER BY id', id);
    const resolved = db.get(`SELECT created_at FROM activity_log WHERE transaction_id = ? AND event = 'recipients_resolved' ORDER BY id LIMIT 1`, n.transaction_id);
    const msg = (ch) => db.get('SELECT * FROM messages WHERE notification_id = ? AND channel = ?', id, ch);
    const stages = [];
    const add = (key, label, state, at, detail) => stages.push({ key, label, state, at: toIso(at), detail });
    add('event', 'Campus event received', 'done', n.e_created, `${n.wf_name} · priority ${n.e_priority}`);
    add('audience', 'Audience resolved', 'done', resolved ? resolved.created_at : n.created_at,
      n.recipient_type === 'broadcast' ? 'Entire university' : n.recipient_type === 'topic' ? `Groups: ${parseJson(n.recipients, []).join(', ')}` : 'Named students');
    add('workflow', 'Workflow triggered', 'done', n.created_at, `Notification created for ${n.external_id}`);
    const digest = jobs.find((j) => j.step_type === 'digest');
    if (!digest) add('timing', 'Timing decision', 'done', n.created_at, 'Deliver immediately');
    else if (digest.status === 'merged') add('timing', 'Timing decision', 'done', digest.updated_at, `Combined into an earlier notification (master job ${digest.master_job_id})`);
    else if (digest.status === 'delayed') add('timing', 'Timing decision', 'active', digest.updated_at, `Collecting related updates until ${toIso(digest.run_at)}`);
    else add('timing', 'Timing decision', digest.status === 'canceled' ? 'skipped' : 'done', digest.completed_at || digest.updated_at,
      `Digest released with ${parseJson(digest.digest_events, []).length} update(s)`);
    for (const j of jobs.filter((x) => x.step_type !== 'digest')) {
      const label = j.step_type === 'email' ? 'Email' : 'In-app';
      const pref = acts.find((a) => a.job_id === j.id && a.event === 'step_skipped');
      add(`pref-${j.step_type}`, `${label}: preference check`, pref ? 'skipped' : ['merged', 'canceled', 'pending'].includes(j.status) ? 'waiting' : 'done', pref ? pref.created_at : j.started_at,
        pref ? pref.message : (n.ignore_mutes ? 'Critical: preferences overridden' : 'Allowed by student preferences'));
      if (pref) continue;
      const deferred = acts.find((a) => a.job_id === j.id && a.event === 'step_deferred');
      if (deferred) add(`focus-${j.step_type}`, `${label}: Focus Mode`, j.status === 'summarized' ? 'done' : 'active', deferred.created_at,
        j.status === 'summarized' ? 'Held, then included in the student\'s catch-up summary' : 'Held while the student is focused');
      const attempts = db.all('SELECT * FROM delivery_attempts WHERE job_id = ? ORDER BY attempt_no', j.id);
      const m = msg(j.step_type);
      const state = j.status === 'completed' ? 'done' : j.status === 'failed' ? 'failed' : j.status === 'retrying' ? 'active'
        : ['merged', 'canceled', 'summarized', 'deferred'].includes(j.status) ? 'skipped' : 'waiting';
      if (!deferred || j.status !== 'summarized') {
        add(`deliver-${j.step_type}`, `${label}: delivery`, state, j.completed_at || j.updated_at,
          j.status === 'merged' ? 'Delivered as part of the combined notification'
            : attempts.length ? attempts.map((a) => `attempt ${a.attempt_no} ${a.status}${a.error ? ` (${a.error})` : ''}`).join(' · ') : j.status);
      }
      if (j.step_type === 'in-app' && m) {
        add('read', 'Read by student', m.read_at || m.seen ? 'done' : 'waiting', m.read_at, m.clicked_at ? `Action clicked ${toIso(m.clicked_at)}` : (m.seen ? 'Opened' : 'Not opened yet'));
      }
      if (j.step_type === 'email' && m && m.provider_status) add('provider', 'Email provider report', m.provider_status === 'delivered' ? 'done' : 'failed', m.updated_at, m.provider_status);
    }
    res.json({
      notificationId: n.id, transactionId: n.transaction_id, workflow: n.wf_name, student: { id: n.external_id, name: [n.first_name, n.last_name].filter(Boolean).join(' ') },
      status: n.status, stages,
    });
  });
}

module.exports = { mountOperationsRoutes };
