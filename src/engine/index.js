'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { openDatabase } = require('../db');
const { createLogger } = require('../logger');
const { createEmailProvider, createFaultInjector } = require('../providers/email');
const { createProviderGuard } = require('../providers/guard');
const { createDeadLetters } = require('./deadletters');
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
  let provider = emailProvider || createEmailProvider(config, log);
  // Demo mode only: let the operator inject provider failures from the Demo Lab.
  const faults = config.demoMode ? createFaultInjector(provider) : null;
  if (faults) provider = faults;
  if (config.demoMode && !config.webhookSecrets.generic) {
    // A per-process secret so the Demo Lab can show a valid signature without anyone configuring one.
    config.webhookSecrets.generic = crypto.randomBytes(24).toString('hex');
  }
  const ctx = {
    config,
    db: db || openDatabase(config.dbPath),
    clock,
    logger: log,
    bus: new EventEmitter(),
    emailProvider: provider,
    faults,
  };
  ctx.bus.setMaxListeners(1000);
  ctx.activity = createActivity(ctx);
  ctx.providerGuard = createProviderGuard({
    clock,
    ratePerSec: config.emailRatePerSec,
    threshold: config.emailBreakerThreshold,
    cooldownMs: config.emailBreakerCooldownMs,
    onTransition: ({ from, to, reason }) => {
      const event = { open: 'circuit_opened', half_open: 'circuit_half_open', closed: 'circuit_closed' }[to];
      ctx.activity.log({ event, status: to === 'open' ? 'failure' : 'info', message: `Email provider circuit ${from} -> ${to}: ${reason}` });
      log.warn('provider circuit transition', { from, to, reason });
    },
  });
  ctx.workflows = createWorkflows(ctx);
  ctx.subscribers = createSubscribers(ctx);
  ctx.pipeline = createPipeline(ctx);
  ctx.focus = createFocus(ctx);
  ctx.ingest = createIngest(ctx);
  ctx.webhooks = createWebhooks(ctx);
  ctx.queries = createQueries(ctx);
  ctx.deadLetters = createDeadLetters(ctx);

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
