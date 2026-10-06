'use strict';

const { HttpError, parseJson } = require('../util');

const STEP_TYPES = ['digest', 'email', 'in-app'];
const CATEGORIES = ['academic', 'campus', 'events', 'administrative', 'clubs'];
const PRIORITIES = ['low', 'normal', 'high', 'critical'];

function normalizeAction(a, field) {
  if (a == null) return null;
  if (typeof a !== 'object' || typeof a.label !== 'string' || !a.label || (a.url != null && typeof a.url !== 'string')) {
    throw new HttpError(400, 'BadRequest', `${field} must be {label, url?}.`);
  }
  return { label: a.label, url: a.url || null };
}
const RULE_OPS = { lt: (a, b) => a < b, lte: (a, b) => a <= b, gt: (a, b) => a > b, gte: (a, b) => a >= b, eq: (a, b) => a === b };

/** Validate and normalise a workflow definition from the admin API or the seed. */
function normalizeDefinition(identifier, def, config) {
  if (!identifier || typeof identifier !== 'string') throw new HttpError(400, 'BadRequest', 'Workflow identifier is required.');
  if (!def || !Array.isArray(def.steps) || def.steps.length === 0) {
    throw new HttpError(400, 'BadRequest', 'steps must be a non-empty array.');
  }
  const steps = def.steps.map((s, i) => {
    if (!s || !STEP_TYPES.includes(s.type)) {
      throw new HttpError(400, 'BadRequest', `steps[${i}].type must be one of ${STEP_TYPES.join(', ')}.`);
    }
    if (s.type === 'digest') {
      if (i !== 0) throw new HttpError(400, 'BadRequest', 'A digest step is only supported as the first step.');
      const windowMs = s.windowMs ?? config.digestWindowMs;
      if (!Number.isInteger(windowMs) || windowMs <= 0) throw new HttpError(400, 'BadRequest', 'digest windowMs must be a positive integer.');
      if (s.groupScope != null && (typeof s.groupScope !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(s.groupScope))) {
        throw new HttpError(400, 'BadRequest', 'digest groupScope must match [a-z0-9_-]{1,40}.');
      }
      const out = { type: 'digest', windowMs, digestKey: s.digestKey || null };
      // Optional cross-workflow grouping (G8): digest steps sharing a groupScope share one master.
      if (s.groupScope) out.groupScope = s.groupScope;
      return out;
    }
    return { type: s.type, subject: String(s.subject ?? ''), body: String(s.body ?? '') };
  });
  if (steps.filter((s) => s.type === 'digest').length > 1) throw new HttpError(400, 'BadRequest', 'Only one digest step is allowed.');
  const rules = def.criticalRules == null ? [] : def.criticalRules;
  if (!Array.isArray(rules) || rules.some((r) => !r || typeof r.field !== 'string' || !RULE_OPS[r.op] || r.value === undefined)) {
    throw new HttpError(400, 'BadRequest', `criticalRules must be [{field, op (${Object.keys(RULE_OPS).join('|')}), value}].`);
  }
  if (def.category != null && !CATEGORIES.includes(def.category)) throw new HttpError(400, 'BadRequest', `category must be one of ${CATEGORIES.join(', ')}.`);
  if (def.priority != null && !PRIORITIES.includes(def.priority)) throw new HttpError(400, 'BadRequest', `priority must be one of ${PRIORITIES.join(', ')}.`);
  return {
    identifier,
    steps,
    name: typeof def.name === 'string' && def.name ? def.name : null,
    description: typeof def.description === 'string' ? def.description : null,
    category: def.category || 'campus',
    priority: def.critical ? 'critical' : (def.priority || 'normal'),
    actions: { primary: normalizeAction(def.primaryAction, 'primaryAction'), secondary: normalizeAction(def.secondaryAction, 'secondaryAction') },
    critical: def.critical || def.priority === 'critical' ? 1 : 0,
    correlationKey: def.correlationKey || null,
    criticalRules: rules,
  };
}

function createWorkflows(ctx) {
  const { db, clock } = ctx;

  const hydrate = (row) => row && ({
    id: row.id,
    identifier: row.identifier,
    steps: parseJson(row.steps, []),
    critical: !!row.critical,
    correlationKey: row.correlation_key,
    criticalRules: parseJson(row.critical_rules, []),
    name: row.name || row.identifier,
    description: row.description || '',
    category: row.category || 'campus',
    priority: row.priority || 'normal',
    primaryAction: (parseJson(row.actions, {}) || {}).primary || null,
    secondaryAction: (parseJson(row.actions, {}) || {}).secondary || null,
  });

  return {
    upsert(identifier, def) {
      const n = normalizeDefinition(identifier, def, ctx.config);
      const now = clock.now();
      db.run(
        `INSERT INTO workflows (identifier, steps, critical, correlation_key, critical_rules, name, description, category, priority,
           actions, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(identifier) DO UPDATE SET steps=excluded.steps, critical=excluded.critical,
           correlation_key=excluded.correlation_key, critical_rules=excluded.critical_rules, name=excluded.name,
           description=excluded.description, category=excluded.category, priority=excluded.priority,
           actions=excluded.actions, updated_at=excluded.updated_at`,
        n.identifier, JSON.stringify(n.steps), n.critical, n.correlationKey, JSON.stringify(n.criticalRules), n.name,
        n.description, n.category, n.priority, JSON.stringify(n.actions), now, now,
      );
      return this.getByIdentifier(identifier);
    },
    getByIdentifier: (identifier) => hydrate(db.get('SELECT * FROM workflows WHERE identifier = ?', identifier)),
    getById: (id) => hydrate(db.get('SELECT * FROM workflows WHERE id = ?', id)),
    list: () => db.all('SELECT * FROM workflows ORDER BY identifier').map(hydrate),

    /**
     * Bypass is decided per event: the workflow is critical, the caller marked it critical, or an
     * admin rule on the payload matches. Rules never throw; a rule on a missing field is false.
     */
    isCritical(workflow, payload, priority) {
      if (workflow.critical || priority === 'critical') return true;
      return workflow.criticalRules.some((r) => {
        const v = payload ? payload[r.field] : undefined;
        if (v === undefined || v === null) return false;
        return RULE_OPS[r.op](typeof r.value === 'number' ? Number(v) : v, r.value);
      });
    },

    /** Events that describe the same underlying thing share this value (e.g. the exam id). */
    correlationValue(workflow, payload) {
      if (workflow.correlationKey && payload && payload[workflow.correlationKey] != null) {
        return `${workflow.correlationKey}:${String(payload[workflow.correlationKey])}`;
      }
      return `workflow:${workflow.identifier}`;
    },
  };
}

module.exports = { createWorkflows, normalizeDefinition, CATEGORIES, PRIORITIES };
