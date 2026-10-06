'use strict';

const { HttpError, parseJson, renderTemplate, toIso } = require('../util');
const { CATEGORIES } = require('../engine/workflows');

/**
 * Product-facing read models and actions for the student portal and the event composer.
 * Everything here reads/writes the same tables the engine uses: no separate "UI data".
 */
function mountProductRoutes(app, ctx, { apiKey, subscriberAuth, currentSubscriber }) {
  const { db, clock } = ctx;

  const PRIORITY_RANK = { critical: 0, high: 1, normal: 2, low: 3 };
  const effectivePriority = (r) => (r.e_priority === 'critical' || r.w_critical ? 'critical'
    : (r.e_priority && r.e_priority !== 'normal' ? r.e_priority : (r.w_priority || 'normal')));
  const render = (action, payload) => action && ({ label: renderTemplate(action.label, payload), url: action.url ? renderTemplate(action.url, payload) : null });

  const SELECT = `SELECT m.*, n.payload AS n_payload, n.correlation_value, n.event_id, n.delivery_email, n.delivery_in_app,
      w.identifier AS wf, w.name AS w_name, w.category AS w_category, w.priority AS w_priority, w.critical AS w_critical,
      w.actions AS w_actions, e.priority AS e_priority, e.recipient_type, e.recipients AS e_recipients,
      (SELECT digest_events FROM jobs j WHERE j.notification_id = n.id AND j.step_type = 'digest') AS digest_events
    FROM messages m JOIN notifications n ON n.id = m.notification_id
    JOIN workflows w ON w.id = n.workflow_id JOIN events e ON e.id = n.event_id`;

  function view(r) {
    const payload = parseJson(r.n_payload, {});
    const actions = parseJson(r.w_actions, {}) || {};
    const digest = parseJson(r.digest_events, []) || [];
    return {
      messageId: `msg_${r.id}`,
      notificationId: `notif_${r.notification_id}`,
      title: r.subject,
      content: r.content,
      category: r.w_category || 'campus',
      priority: effectivePriority(r),
      source: r.w_name || r.wf,
      workflowId: r.wf,
      seen: !!r.seen,
      archived: !!r.archived,
      createdAt: toIso(r.created_at),
      readAt: toIso(r.read_at),
      clickedAt: toIso(r.clicked_at),
      updates: digest.length > 1 ? digest.length : 1,
      payload,
      primaryAction: render(actions.primary, payload),
      secondaryAction: render(actions.secondary, payload),
    };
  }

  function ownMessage(subscriber, messageId) {
    const m = /^msg_(\d+)$/.exec(String(messageId));
    const row = m && db.get(`${SELECT} WHERE m.id = ? AND m.subscriber_id = ? AND m.channel = 'in-app'`, Number(m[1]), subscriber.id);
    if (!row) throw new HttpError(404, 'NotFound', 'Notification not found.');
    return row;
  }

  // ---------------------------------------------------------------- student feed

  app.get('/inbox/feed', subscriberAuth, (req, res) => {
    const sub = currentSubscriber(req);
    const q = req.query;
    const where = ['m.subscriber_id = ?', "m.channel = 'in-app'"];
    const params = [sub.id];
    if (q.category) {
      if (!CATEGORIES.includes(q.category)) throw new HttpError(400, 'BadRequest', 'Unknown category.');
      where.push('w.category = ?'); params.push(q.category);
    }
    if (q.priority === 'critical') where.push("(e.priority = 'critical' OR w.critical = 1)");
    if (q.seen === 'false') where.push('m.seen = 0');
    where.push(q.archived === 'true' ? 'm.archived = 1' : 'm.archived = 0');
    if (q.q) {
      where.push('(m.subject LIKE ? OR m.content LIKE ? OR w.name LIKE ?)');
      const like = `%${String(q.q).slice(0, 100)}%`;
      params.push(like, like, like);
    }
    const limit = Math.min(Math.max(Number.parseInt(q.limit ?? '100', 10) || 100, 1), 200);
    const rows = db.all(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC, m.id DESC LIMIT ?`, ...params, limit);
    let items = rows.map(view);
    if (q.sort === 'oldest') items.reverse();
    if (q.sort === 'priority') items = items.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
    const counts = db.get(
      `SELECT COUNT(*) AS total, SUM(m.seen = 0) AS unread,
              SUM(m.seen = 0 AND (e.priority = 'critical' OR w.critical = 1)) AS criticalUnread
         FROM messages m JOIN notifications n ON n.id = m.notification_id JOIN workflows w ON w.id = n.workflow_id
         JOIN events e ON e.id = n.event_id WHERE m.subscriber_id = ? AND m.channel = 'in-app' AND m.archived = 0`, sub.id,
    );
    const byCategory = Object.fromEntries(db.all(
      `SELECT w.category AS c, COUNT(*) AS n FROM messages m JOIN notifications n ON n.id = m.notification_id
         JOIN workflows w ON w.id = n.workflow_id WHERE m.subscriber_id = ? AND m.channel = 'in-app' AND m.archived = 0 AND m.seen = 0
         GROUP BY w.category`, sub.id,
    ).map((r) => [r.c, r.n]));
    res.json({ items, counts: { total: counts.total || 0, unread: counts.unread || 0, criticalUnread: counts.criticalUnread || 0, unreadByCategory: byCategory } });
  });

  app.get('/inbox/feed/:messageId', subscriberAuth, (req, res) => {
    const sub = currentSubscriber(req);
    const row = ownMessage(sub, req.params.messageId);
    const item = view(row);
    // Why did I get this?
    let reason;
    if (row.recipient_type === 'broadcast') reason = 'Sent to everyone at the university.';
    else if (row.recipient_type === 'explicit') reason = 'Sent to you personally.';
    else {
      const keys = parseJson(row.e_recipients, []);
      const mine = keys.length ? db.all(
        `SELECT t.key, COALESCE(c.name, t.key) AS name FROM (SELECT topic AS key FROM topic_members WHERE subscriber_id = ? AND topic IN (${keys.map(() => '?').join(',')})) t
         LEFT JOIN topics c ON c.key = t.key`, sub.id, ...keys,
      ) : [];
      reason = mine.length ? `You're in ${mine.map((t) => t.name).join(', ')}.` : 'Sent to a group you were in when it was published.';
    }
    if (item.priority === 'critical') reason += ' Marked critical, so it is delivered even if you muted this category or are in Focus Mode.';
    const digest = (parseJson(row.digest_events, []) || []).map((d) => ({ at: toIso(d.at), payload: d.payload }));
    const related = db.all(
      `${SELECT} WHERE m.subscriber_id = ? AND m.channel = 'in-app' AND n.correlation_value = ? AND m.id != ?
       ORDER BY m.created_at DESC LIMIT 5`, sub.id, row.correlation_value, row.id,
    ).map(view);
    const email = db.get(`SELECT status, provider_status, created_at FROM messages WHERE notification_id = ? AND channel = 'email'`, row.notification_id);
    res.json({
      ...item, reason, digest, related,
      delivery: {
        inApp: row.delivery_in_app,
        email: row.delivery_email,
        emailSentAt: email ? toIso(email.created_at) : null,
        emailProviderStatus: email ? email.provider_status : null,
      },
    });
  });

  app.post('/inbox/feed/:messageId/read', subscriberAuth, (req, res) => {
    const row = ownMessage(currentSubscriber(req), req.params.messageId);
    const read = !(req.body && req.body.read === false);
    db.run('UPDATE messages SET seen = ?, read_at = CASE WHEN ? = 1 THEN COALESCE(read_at, ?) ELSE NULL END, updated_at = ? WHERE id = ?',
      read ? 1 : 0, read ? 1 : 0, clock.now(), clock.now(), row.id);
    res.json({ messageId: `msg_${row.id}`, seen: read });
  });

  app.post('/inbox/feed/:messageId/click', subscriberAuth, (req, res) => {
    const row = ownMessage(currentSubscriber(req), req.params.messageId);
    const now = clock.now();
    db.run('UPDATE messages SET clicked_at = COALESCE(clicked_at, ?), seen = 1, read_at = COALESCE(read_at, ?), updated_at = ? WHERE id = ?', now, now, now, row.id);
    res.json({ messageId: `msg_${row.id}`, clicked: true });
  });

  app.post('/inbox/read-all', subscriberAuth, (req, res) => {
    const sub = currentSubscriber(req);
    const now = clock.now();
    const cat = req.body && req.body.category;
    if (cat && !CATEGORIES.includes(cat)) throw new HttpError(400, 'BadRequest', 'Unknown category.');
    const r = cat
      ? db.run(`UPDATE messages SET seen = 1, read_at = COALESCE(read_at, ?), updated_at = ? WHERE subscriber_id = ? AND channel = 'in-app' AND seen = 0
                AND notification_id IN (SELECT n.id FROM notifications n JOIN workflows w ON w.id = n.workflow_id WHERE w.category = ?)`, now, now, sub.id, cat)
      : db.run(`UPDATE messages SET seen = 1, read_at = COALESCE(read_at, ?), updated_at = ? WHERE subscriber_id = ? AND channel = 'in-app' AND seen = 0`, now, now, sub.id);
    res.json({ updated: Number(r.changes) });
  });

  // ---------------------------------------------------------------- preferences by category

  app.patch('/inbox/preferences/categories/:category', subscriberAuth, (req, res) => {
    const sub = currentSubscriber(req);
    if (!CATEGORIES.includes(req.params.category)) throw new HttpError(404, 'NotFound', 'Unknown category.');
    const patch = {};
    for (const k of ['email', 'inApp']) {
      if (req.body && req.body[k] !== undefined) {
        if (typeof req.body[k] !== 'boolean') throw new HttpError(400, 'BadRequest', `${k} must be a boolean.`);
        patch[k] = req.body[k];
      }
    }
    if (!Object.keys(patch).length) throw new HttpError(400, 'BadRequest', 'Provide email and/or inApp.');
    res.json({ category: req.params.category, preferences: ctx.subscribers.setCategoryPreferences(sub, req.params.category, patch) });
  });

  // ---------------------------------------------------------------- topics

  const topicView = (t, sub) => ({
    key: t.key, name: t.name, description: t.description, kind: t.kind, followable: !!t.followable,
    members: db.get('SELECT COUNT(*) AS n FROM topic_members WHERE topic = ?', t.key).n,
    following: !!db.get('SELECT 1 AS x FROM topic_members WHERE topic = ? AND subscriber_id = ?', t.key, sub.id),
  });

  app.get('/inbox/topics', subscriberAuth, (req, res) => {
    const sub = currentSubscriber(req);
    res.json({ topics: db.all('SELECT * FROM topics ORDER BY kind, name').map((t) => topicView(t, sub)) });
  });

  app.get('/inbox/topics/:key', subscriberAuth, (req, res) => {
    const sub = currentSubscriber(req);
    const t = db.get('SELECT * FROM topics WHERE key = ?', req.params.key);
    if (!t) throw new HttpError(404, 'NotFound', 'Topic not found.');
    const events = db.all(
      `SELECT e.transaction_id, e.created_at, e.payload, w.name, w.category FROM events e JOIN workflows w ON w.id = e.workflow_id
       WHERE e.recipient_type = 'topic' AND EXISTS (SELECT 1 FROM json_each(e.recipients) j WHERE j.value = ?)
       ORDER BY e.id DESC LIMIT 10`, t.key,
    );
    const workflows = [...new Set(events.map((e) => e.name))];
    res.json({
      ...topicView(t, sub),
      generates: workflows,
      recent: events.map((e) => ({ at: toIso(e.created_at), workflow: e.name, category: e.category, title: parseJson(e.payload, {}).title || null })),
    });
  });

  app.post('/inbox/topics/:key/follow', subscriberAuth, (req, res) => res.json(ctx.subscribers.follow(currentSubscriber(req), req.params.key, true)));
  app.delete('/inbox/topics/:key/follow', subscriberAuth, (req, res) => res.json(ctx.subscribers.follow(currentSubscriber(req), req.params.key, false)));

  app.get('/inbox/profile', subscriberAuth, (req, res) => {
    const s = currentSubscriber(req);
    res.json({
      subscriberId: s.external_id, email: s.email, firstName: s.first_name, lastName: s.last_name,
      department: s.department, year: s.year, program: s.program,
      topics: db.all('SELECT t.topic AS key, COALESCE(c.name, t.topic) AS name, c.kind FROM topic_members t LEFT JOIN topics c ON c.key = t.topic WHERE t.subscriber_id = ? ORDER BY c.kind, name', s.id),
    });
  });

  // ---------------------------------------------------------------- admin: audiences

  app.get('/admin/audiences', apiKey, (_req, res) => {
    const rows = db.all(
      `SELECT c.*, (SELECT COUNT(*) FROM topic_members t WHERE t.topic = c.key) AS members FROM topics c ORDER BY c.kind, c.name`,
    );
    res.json({
      everyone: ctx.subscribers.count(),
      groups: rows.map((t) => ({ key: t.key, name: t.name, description: t.description, kind: t.kind, followable: !!t.followable, members: t.members })),
    });
  });

  app.post('/admin/audiences/estimate', apiKey, (req, res) => {
    const b = req.body || {};
    if (b.everyone) return res.json({ students: ctx.subscribers.count() });
    const topics = Array.isArray(b.topics) ? b.topics.filter((t) => typeof t === 'string').slice(0, 20) : [];
    return res.json({ students: ctx.subscribers.audienceSize(topics) });
  });

  app.put('/admin/audiences/:key', apiKey, (req, res) => {
    const t = ctx.subscribers.upsertTopic(req.params.key, req.body || {});
    res.json({ key: t.key, name: t.name, kind: t.kind });
  });
}

module.exports = { mountProductRoutes };
