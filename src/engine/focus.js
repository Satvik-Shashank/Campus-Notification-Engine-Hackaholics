'use strict';

const { HttpError, parseJson } = require('../util');

const SUMMARY_WORKFLOW = '__focus_summary__';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** True when every field of `event` is already stated, with the same value, in `known`. */
const isCoveredBy = (event, known) => Object.keys(event).every((k) => k in known && same(event[k], known[k]));

const labelFor = (correlation) => {
  const i = correlation.indexOf(':');
  const key = correlation.slice(0, i);
  const value = correlation.slice(i + 1);
  return key === 'workflow' ? value : `${key} ${value}`;
};

/**
 * Intelligent Focus Mode.
 *  - non-critical deliveries are held while a session is active (pipeline calls hold())
 *  - critical ones go through and are remembered (recordBypass())
 *  - when the session ends, held events are correlated, redundant ones dropped, and one catch-up
 *    notification is created through the normal pipeline (so email mutes etc. still apply).
 */
function createFocus(ctx) {
  const { db, clock, config } = ctx;

  const parseDuration = (input) => {
    let minutes;
    if (typeof input === 'number') minutes = input;
    else if (typeof input === 'string') {
      const m = /^(\d+)\s*(m|h)$/i.exec(input.trim());
      if (m) minutes = Number(m[1]) * (m[2].toLowerCase() === 'h' ? 60 : 1);
    }
    if (!Number.isInteger(minutes) || minutes <= 0) {
      throw new HttpError(400, 'BadRequest', 'duration must be like "30m" or "2h" (or a positive number of minutes).');
    }
    if (minutes > config.focusMaxHours * 60) {
      throw new HttpError(400, 'BadRequest', `duration may not exceed ${config.focusMaxHours}h.`);
    }
    return minutes;
  };

  const view = (s) => s && ({
    sessionId: s.id, status: s.status, startsAt: new Date(s.starts_at).toISOString(),
    endsAt: new Date(s.ends_at).toISOString(),
    endedAt: s.ended_at ? new Date(s.ended_at).toISOString() : null,
  });

  function activeSession(subscriberId, now) {
    return db.get(
      `SELECT * FROM focus_sessions WHERE subscriber_id = ? AND status = 'active' AND starts_at <= ? AND ends_at > ?`,
      subscriberId, now, now,
    );
  }

  function hold(session, notification) {
    db.run(
      `INSERT OR IGNORE INTO held_events (session_id, subscriber_id, notification_id, correlation_value, payload, disposition, created_at)
       VALUES (?,?,?,?,?, 'held', ?)`,
      session.id, notification.subscriber_id, notification.id, notification.correlation_value, notification.payload, clock.now(),
    );
  }

  /** Returns true the first time a critical notification is recorded for this session. */
  function recordBypass(session, notification) {
    return db.run(
      `INSERT OR IGNORE INTO held_events (session_id, subscriber_id, notification_id, correlation_value, payload, disposition, created_at)
       VALUES (?,?,?,?,?, 'bypassed', ?)`,
      session.id, notification.subscriber_id, notification.id, notification.correlation_value, notification.payload, clock.now(),
    ).changes === 1;
  }

  /** Pure summary builder: rows are held_events, acked is [{correlation, payload}] the user already saw. */
  function buildSummary(rows, acked) {
    const parsed = rows.map((r) => ({ ...r, data: parseJson(r.payload, {}) }));
    const ackedBy = new Map();
    const addAck = (corr, payload) => ackedBy.set(corr, [...(ackedBy.get(corr) || []), payload]);
    for (const r of parsed.filter((p) => p.disposition === 'bypassed')) addAck(r.correlation_value, r.data);
    for (const a of acked) addAck(a.correlation, a.payload);

    const groups = new Map();
    for (const r of parsed.filter((p) => p.disposition === 'held')) {
      groups.set(r.correlation_value, [...(groups.get(r.correlation_value) || []), r.data]);
    }

    let suppressedAcknowledged = 0;
    let suppressedDuplicates = 0;
    const items = [];
    for (const [corr, payloads] of groups) {
      const known = ackedBy.get(corr) || [];
      const fresh = payloads.filter((p) => {
        const covered = known.some((k) => isCoveredBy(p, k));
        if (covered) suppressedAcknowledged += 1;
        return !covered;
      });
      const unique = [];
      for (const p of fresh) {
        const idx = unique.findIndex((u) => same(u, p));
        if (idx >= 0) {
          suppressedDuplicates += 1;
          unique.splice(idx, 1);
        }
        unique.push(p);
      }
      if (unique.length === 0) continue;
      const latest = Object.assign({}, ...unique);
      const changes = [];
      for (const field of Object.keys(latest)) {
        const values = unique.filter((p) => field in p).map((p) => p[field]);
        const distinct = [...new Set(values.map((v) => JSON.stringify(v)))];
        if (distinct.length > 1) changes.push({ field, from: values[0], to: values[values.length - 1] });
      }
      items.push({
        correlation: corr,
        label: labelFor(corr),
        latest,
        changes,
        relatedEvents: payloads.length,
        actionRequired: unique.some((p) => p.actionRequired === true),
        action: [...unique].reverse().map((p) => p.action).find(Boolean) || null,
      });
    }
    items.sort((a, b) => Number(b.actionRequired) - Number(a.actionRequired));

    const interrupted = [];
    for (const [corr, payloads] of ackedBy) {
      if (parsed.some((p) => p.disposition === 'bypassed' && p.correlation_value === corr)) {
        interrupted.push({ correlation: corr, label: labelFor(corr), count: payloads.length });
      }
    }

    const describe = (it) => {
      const skip = new Set(['actionRequired', 'action']);
      const core = it.changes.length
        ? it.changes.map((c) => `${c.field}: ${c.from} -> ${c.to}`).join(', ')
        : Object.entries(it.latest).filter(([k]) => !skip.has(k)).map(([k, v]) => `${k}: ${v}`).join(', ');
      const related = it.relatedEvents > 1 ? ` (${it.relatedEvents} related updates)` : '';
      const action = it.action ? ` ACTION: ${it.action}` : (it.actionRequired ? ' ACTION REQUIRED' : '');
      return `- ${it.label}: ${core}${related}${action}`;
    };
    const lines = items.map(describe);
    if (interrupted.length) lines.push(`Already delivered immediately: ${interrupted.map((i) => i.label).join(', ')}`);
    const subject = `Focus catch-up: ${items.length} change${items.length === 1 ? '' : 's'} while you were away`;
    return {
      subject,
      text: lines.join('\n'),
      items,
      interrupted,
      suppressed: { acknowledged: suppressedAcknowledged, duplicates: suppressedDuplicates },
    };
  }

  function seenByUser(session) {
    return db.all(
      `SELECT n.correlation_value AS correlation, n.payload AS payload
         FROM messages m JOIN notifications n ON n.id = m.notification_id
        WHERE m.subscriber_id = ? AND m.channel = 'in-app' AND m.seen = 1 AND m.updated_at >= ?`,
      session.subscriber_id, session.starts_at,
    ).map((r) => ({ correlation: r.correlation, payload: parseJson(r.payload, {}) }));
  }

  function endSession(sessionId) {
    return db.tx(() => {
      const session = db.get(`SELECT * FROM focus_sessions WHERE id = ? AND status = 'active'`, sessionId);
      if (!session) return null;
      const now = clock.now();
      db.run(`UPDATE focus_sessions SET status = 'ended', ended_at = ? WHERE id = ?`, now, session.id);
      const rows = db.all('SELECT * FROM held_events WHERE session_id = ? ORDER BY id', session.id);
      const summary = buildSummary(rows, seenByUser(session));
      const heldNotificationIds = rows.filter((r) => r.disposition === 'held').map((r) => r.notification_id);

      let notificationId = null;
      if (summary.items.length > 0) {
        const workflow = ctx.workflows.getByIdentifier(SUMMARY_WORKFLOW);
        const transactionId = `focus-summary-${session.id}`;
        const payload = { subject: summary.subject, text: summary.text };
        db.run(
          `INSERT INTO events (transaction_id, workflow_id, payload, priority, recipient_type, recipients, recipient_count,
             status, next_attempt_at, response, created_at, updated_at, expires_at)
           VALUES (?,?,?, 'normal', 'explicit', '[]', 1, 'processed', ?, '{}', ?, ?, ?)`,
          transactionId, workflow.id, JSON.stringify(payload), now, now, now, now + config.dedupWindowMs,
        );
        const event = db.get('SELECT * FROM events WHERE transaction_id = ?', transactionId);
        const subscriber = db.get('SELECT * FROM subscribers WHERE id = ?', session.subscriber_id);
        notificationId = ctx.pipeline.createNotification({
          event, workflow, subscriber, payload, bypassFocus: true, ignoreMutes: false,
        });
      }

      for (const nid of heldNotificationIds) {
        db.run(`UPDATE jobs SET status = 'summarized', updated_at = ? WHERE notification_id = ? AND status = 'deferred'`, now, nid);
        for (const channel of ['email', 'in-app']) {
          const col = channel === 'email' ? 'delivery_email' : 'delivery_in_app';
          db.run(`UPDATE notifications SET ${col} = 'summarized', updated_at = ? WHERE id = ? AND ${col} = 'deferred'`, now, nid);
        }
        ctx.pipeline.rollup(nid);
      }

      const stored = { ...summary, sent: notificationId !== null, heldCount: heldNotificationIds.length };
      db.run(
        `INSERT INTO focus_summaries (session_id, subscriber_id, content, text, notification_id, created_at) VALUES (?,?,?,?,?,?)`,
        session.id, session.subscriber_id, JSON.stringify(stored), summary.text, notificationId, now,
      );
      ctx.activity.log({
        subscriberId: session.subscriber_id, transactionId: `focus-summary-${session.id}`, event: 'focus_summary_created',
        status: 'success', message: `${summary.items.length} item(s) from ${heldNotificationIds.length} held notification(s)`,
      });
      return stored;
    });
  }

  function endDueSessions() {
    const due = db.all(`SELECT id FROM focus_sessions WHERE status = 'active' AND ends_at <= ?`, clock.now());
    for (const { id } of due) endSession(id);
    return due.length;
  }

  return {
    SUMMARY_WORKFLOW,
    activeSession,
    hold,
    recordBypass,
    buildSummary,
    endSession,
    endDueSessions,

    start(subscriber, duration) {
      const minutes = parseDuration(duration);
      const now = clock.now();
      const current = db.get(`SELECT * FROM focus_sessions WHERE subscriber_id = ? AND status = 'active'`, subscriber.id);
      if (current && current.ends_at <= now) endSession(current.id);
      else if (current) throw new HttpError(409, 'Conflict', 'Focus Mode is already active. End it first.');
      const r = db.run(
        `INSERT INTO focus_sessions (subscriber_id, starts_at, ends_at) VALUES (?,?,?)`,
        subscriber.id, now, now + minutes * 60000,
      );
      return view(db.get('SELECT * FROM focus_sessions WHERE id = ?', Number(r.lastInsertRowid)));
    },

    end(subscriber) {
      const current = db.get(`SELECT * FROM focus_sessions WHERE subscriber_id = ? AND status = 'active'`, subscriber.id);
      if (!current) throw new HttpError(404, 'NotFound', 'No active Focus Mode session.');
      const summary = endSession(current.id);
      return { session: view(db.get('SELECT * FROM focus_sessions WHERE id = ?', current.id)), summary };
    },

    status(subscriber) {
      const s = db.get(`SELECT * FROM focus_sessions WHERE subscriber_id = ? AND status = 'active'`, subscriber.id);
      const heldCount = s ? db.get(`SELECT COUNT(*) AS n FROM held_events WHERE session_id = ? AND disposition = 'held'`, s.id).n : 0;
      return { active: !!s && s.ends_at > clock.now(), session: view(s) || null, heldCount };
    },

    latestSummary(subscriber, sessionId) {
      const row = sessionId
        ? db.get('SELECT * FROM focus_summaries WHERE subscriber_id = ? AND session_id = ?', subscriber.id, sessionId)
        : db.get('SELECT * FROM focus_summaries WHERE subscriber_id = ? ORDER BY id DESC LIMIT 1', subscriber.id);
      if (!row) throw new HttpError(404, 'NotFound', 'No catch-up summary found.');
      return { sessionId: row.session_id, createdAt: new Date(row.created_at).toISOString(), ...parseJson(row.content, {}) };
    },
  };
}

module.exports = { createFocus, SUMMARY_WORKFLOW };
