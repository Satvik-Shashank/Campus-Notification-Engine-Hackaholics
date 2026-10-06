'use strict';

const { EventEmitter } = require('node:events');
const { openDatabase } = require('../db');
const { createLogger } = require('../logger');
const { createEmailProvider } = require('../providers/email');
const { createActivity } = require('./activity');
const { createWorkflows } = require('./workflows');
const { createSubscribers } = require('./subscribers');
const { createIngest } = require('./ingest');
const { createPipeline } = require('./pipeline');
const { createFocus, SUMMARY_WORKFLOW } = require('./focus');
const { createWebhooks } = require('./webhooks');
const { createQueries } = require('./queries');

const systemClock = { now: () => Date.now() };

/**
 * Wire the engine. Everything that touches the outside world is injectable:
 * db (default in-memory SQLite), clock, emailProvider, logger.
 */
function createEngine({ config, db, clock = systemClock, emailProvider, logger } = {}) {
  const log = logger || createLogger('info');
  const ctx = {
    config,
    db: db || openDatabase(config.dbPath),
    clock,
    logger: log,
    bus: new EventEmitter(),
    emailProvider: emailProvider || createEmailProvider(config, log),
  };
  ctx.activity = createActivity(ctx);
  ctx.workflows = createWorkflows(ctx);
  ctx.subscribers = createSubscribers(ctx);
  ctx.pipeline = createPipeline(ctx);
  ctx.focus = createFocus(ctx);
  ctx.ingest = createIngest(ctx);
  ctx.webhooks = createWebhooks(ctx);
  ctx.queries = createQueries(ctx);

  // The catch-up summary is delivered like any other notification, through this internal workflow.
  ctx.workflows.upsert(SUMMARY_WORKFLOW, {
    steps: [
      { type: 'email', subject: '{{subject}}', body: '{{text}}' },
      { type: 'in-app', subject: '{{subject}}', body: '{{text}}' },
    ],
  });

  let ticking = null;

  /**
   * One worker pass: fan out new events, close due digest windows and focus sessions, then run every
   * runnable job (which can cascade through a whole chain). Safe to call concurrently; calls queue up.
   */
  async function runTick() {
    const stats = { events: 0, digestsReleased: 0, focusEnded: 0, jobs: 0 };
    stats.events = ctx.ingest.processDueEvents();
    stats.digestsReleased = ctx.pipeline.releaseDueDigests();
    stats.focusEnded = ctx.focus.endDueSessions();
    stats.jobs = await ctx.pipeline.runDueJobs();
    // Jobs can end a focus session's summary creation or release follow-ups; one more cheap pass settles them.
    stats.events += ctx.ingest.processDueEvents();
    return stats;
  }

  function tick() {
    const next = (ticking || Promise.resolve()).catch(() => {}).then(runTick);
    ticking = next;
    return next;
  }

  let timer = null;
  return {
    ctx,
    tick,
    startWorker() {
      if (timer) return;
      timer = setInterval(() => {
        tick().catch((err) => log.error('worker tick failed; will retry next tick', { error: err.message }));
      }, config.workerTickMs);
      timer.unref();
    },
    stopWorker() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    async close() {
      this.stopWorker();
      await (ticking || Promise.resolve()).catch(() => {});
      ctx.db.close();
    },
  };
}

module.exports = { createEngine, systemClock };
