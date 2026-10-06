'use strict';

const { HttpError } = require('../util');

const CHANNELS = [['email', 'email'], ['inApp', 'in_app']];

function createSubscribers(ctx) {
  const { db, clock } = ctx;

  const byExternal = (externalId) => db.get('SELECT * FROM subscribers WHERE external_id = ?', externalId);

  const prefRows = (subscriberId) => db.all('SELECT * FROM preferences WHERE subscriber_id = ?', subscriberId);

  function upsertPref(subscriberId, scope, workflowKey, patch) {
    const now = clock.now();
    const e = patch.email === undefined ? null : (patch.email ? 1 : 0);
    const a = patch.inApp === undefined ? null : (patch.inApp ? 1 : 0);
    db.run(
      `INSERT INTO preferences (subscriber_id, scope, workflow_key, email, in_app, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(subscriber_id, scope, workflow_key) DO UPDATE SET
         email = COALESCE(?, email), in_app = COALESCE(?, in_app), updated_at = ?`,
      subscriberId, scope, workflowKey, e, a, now, now, e, a, now,
    );
  }

  return {
    byExternal,

    upsert(externalId, fields = {}) {
      if (!externalId || typeof externalId !== 'string') throw new HttpError(400, 'BadRequest', 'subscriberId is required.');
      const now = clock.now();
      db.run(
        `INSERT INTO subscribers (external_id, email, first_name, last_name, created_at, updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(external_id) DO UPDATE SET email = COALESCE(excluded.email, email),
           first_name = COALESCE(excluded.first_name, first_name),
           last_name = COALESCE(excluded.last_name, last_name), updated_at = excluded.updated_at`,
        externalId, fields.email ?? null, fields.firstName ?? null, fields.lastName ?? null, now, now,
      );
      if (fields.department !== undefined || fields.year !== undefined || fields.program !== undefined) {
        db.run(`UPDATE subscribers SET department = COALESCE(?, department), year = COALESCE(?, year), program = COALESCE(?, program)
                WHERE external_id = ?`, fields.department ?? null, fields.year ?? null, fields.program ?? null, externalId);
      }
      return byExternal(externalId);
    },

    setTopicMembers(topic, externalIds) {
      if (!topic || !Array.isArray(externalIds)) throw new HttpError(400, 'BadRequest', 'topic and subscriberIds[] are required.');
      return db.tx(() => {
        let added = 0;
        for (const ext of externalIds) {
          const s = byExternal(ext);
          if (!s) throw new HttpError(400, 'BadRequest', `Unknown subscriber '${ext}'.`);
          added += db.run('INSERT OR IGNORE INTO topic_members (topic, subscriber_id) VALUES (?,?)', topic, s.id).changes;
        }
        return added;
      });
    },

    audienceMembers: (topics) => db.all(
      `SELECT DISTINCT s.external_id FROM topic_members t JOIN subscribers s ON s.id = t.subscriber_id
       WHERE t.topic IN (${topics.map(() => '?').join(',')}) ORDER BY s.id`, ...topics,
    ).map((r) => r.external_id),
    audienceSize: (topics) => (topics.length ? db.get(
      `SELECT COUNT(DISTINCT subscriber_id) AS n FROM topic_members WHERE topic IN (${topics.map(() => '?').join(',')})`, ...topics,
    ).n : 0),

    upsertTopic(key, meta = {}) {
      if (!key || typeof key !== 'string' || !/^[\w:.-]{1,80}$/.test(key)) throw new HttpError(400, 'BadRequest', 'Invalid topic key.');
      if (typeof meta.name !== 'string' || !meta.name) throw new HttpError(400, 'BadRequest', 'Topic name is required.');
      db.run(
        `INSERT INTO topics (key, name, description, kind, followable, created_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET name = excluded.name, description = excluded.description, kind = excluded.kind,
           followable = excluded.followable`,
        key, meta.name, meta.description ?? null, meta.kind || 'interest', meta.followable === false ? 0 : 1, clock.now(),
      );
      return db.get('SELECT * FROM topics WHERE key = ?', key);
    },

    follow(subscriber, key, on) {
      const t = db.get('SELECT * FROM topics WHERE key = ?', key);
      if (!t) throw new HttpError(404, 'NotFound', 'Topic not found.');
      if (!t.followable) throw new HttpError(409, 'Conflict', 'This group is assigned by the university and cannot be changed here.');
      if (on) db.run('INSERT OR IGNORE INTO topic_members (topic, subscriber_id) VALUES (?,?)', key, subscriber.id);
      else db.run('DELETE FROM topic_members WHERE topic = ? AND subscriber_id = ?', key, subscriber.id);
      return { topic: key, following: !!on };
    },

    setCategoryPreferences(subscriber, category, patch) {
      upsertPref(subscriber.id, 'workflow', `category:${category}`, patch);
      return this.getPreferences(subscriber).categories[category];
    },

    topicMembers: (topic) => db.all(
      `SELECT s.external_id FROM topic_members t JOIN subscribers s ON s.id = t.subscriber_id
       WHERE t.topic = ? ORDER BY s.id`, topic,
    ).map((r) => r.external_id),

    allExternalIds: () => db.all('SELECT external_id FROM subscribers ORDER BY id').map((r) => r.external_id),
    count: () => db.get('SELECT COUNT(*) AS n FROM subscribers').n,

    /** Public view used by GET /inbox/preferences. */
    getPreferences(subscriber) {
      const out = { subscriberId: subscriber.external_id, global: { email: true, inApp: true }, workflows: {}, categories: {} };
      for (const r of prefRows(subscriber.id)) {
        const view = {};
        for (const [name, col] of CHANNELS) if (r[col] !== null) view[name] = !!r[col];
        if (r.scope === 'global') Object.assign(out.global, view);
        else if (r.workflow_key.startsWith('category:')) out.categories[r.workflow_key.slice(9)] = view;
        else out.workflows[r.workflow_key] = view;
      }
      return out;
    },

    setGlobalPreferences(subscriber, patch) {
      upsertPref(subscriber.id, 'global', '', patch);
      return this.getPreferences(subscriber).global;
    },

    setWorkflowPreferences(subscriber, workflowIdentifier, patch) {
      upsertPref(subscriber.id, 'workflow', workflowIdentifier, patch);
      return this.getPreferences(subscriber).workflows[workflowIdentifier];
    },

    /** Admin switch for the preference-level read_only flag (ignores mutes). */
    setReadOnly(subscriberId, workflowKey, flag) {
      const scope = workflowKey ? 'workflow' : 'global';
      upsertPref(subscriberId, scope, workflowKey || '', {});
      db.run('UPDATE preferences SET read_only = ? WHERE subscriber_id = ? AND scope = ? AND workflow_key = ?',
        flag ? 1 : 0, subscriberId, scope, workflowKey || '');
    },

    /**
     * Effective channel switches, evaluated when a job runs (not at trigger time).
     * Order: workflow override > category > global > default true. Workflow-level `critical` or a preference
     * row flagged read_only force every channel on.
     */
    resolve(subscriberId, workflow) {
      const rows = prefRows(subscriberId);
      const global = rows.find((r) => r.scope === 'global');
      const wf = rows.find((r) => r.scope === 'workflow' && r.workflow_key === workflow.identifier);
      const cat = rows.find((r) => r.scope === 'workflow' && r.workflow_key === `category:${workflow.category || 'campus'}`);
      const pick = (col) => {
        if (wf && wf[col] !== null) return !!wf[col];
        if (cat && cat[col] !== null) return !!cat[col];
        if (global && global[col] !== null) return !!global[col];
        return true;
      };
      const forced = workflow.critical || rows.some((r) => r.read_only && (r.scope === 'global' || r === wf));
      return { email: forced || pick('email'), inApp: forced || pick('in_app'), forced };
    },
  };
}

module.exports = { createSubscribers };
