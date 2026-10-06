'use strict';

const path = require('node:path');
const express = require('express');
const { HttpError, toIso } = require('../util');
const { signJwt, requireApiKey, requireSubscriber, rateLimiter } = require('./auth');

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function parsePrefPatch(body) {
  if (!isPlainObject(body)) throw new HttpError(400, 'BadRequest', 'Body must be a JSON object.');
  const patch = {};
  for (const key of ['email', 'inApp']) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') throw new HttpError(400, 'BadRequest', `${key} must be a boolean.`);
    patch[key] = body[key];
  }
  if (Object.keys(patch).length === 0) throw new HttpError(400, 'BadRequest', 'Provide at least one of: email, inApp.');
  return patch;
}

function createApp(engine) {
  const { ctx } = engine;
  const { config, clock } = ctx;
  const app = express();
  app.disable('x-powered-by');

  const apiKey = requireApiKey(ctx);
  const subscriberAuth = requireSubscriber(ctx);
  const limit = rateLimiter(ctx);
  const currentSubscriber = (req) => {
    const s = ctx.subscribers.byExternal(req.subscriberExternalId);
    if (!s) throw new HttpError(404, 'NotFound', 'Subscriber not found.');
    return s;
  };

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Inbound provider webhooks need the raw bytes for signature checks, so they get a raw parser.
  app.post('/webhooks/:provider', express.raw({ type: () => true, limit: '1mb' }), (req, res, next) => {
    try {
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      let body = null;
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        body = null;
      }
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
      const out = ctx.webhooks.handle(req.params.provider.toLowerCase(), { rawBody, headers, body });
      res.status(out.status).json(out.body);
    } catch (err) {
      next(err);
    }
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  // ---- event producers (API key) ----
  app.post('/events/trigger', apiKey, limit, (req, res) => {
    res.status(202).json(ctx.ingest.accept(req.body, req.get('idempotency-key')));
  });
  app.post('/events/trigger/bulk', apiKey, limit, (req, res) => {
    const out = ctx.ingest.acceptBulk(req.body);
    res.status(out.acceptedCount === 0 ? 400 : 202).json(out);
  });
  app.post('/events/trigger/broadcast', apiKey, limit, (req, res) => {
    res.status(202).json(ctx.ingest.acceptBroadcast(req.body, req.get('idempotency-key')));
  });
  app.delete('/events/trigger/:transactionId', apiKey, (req, res) => {
    const out = ctx.pipeline.cancelTransaction(req.params.transactionId);
    if (!out) throw new HttpError(404, 'NotFound', `transactionId '${req.params.transactionId}' not found.`);
    res.json({
      status: 'canceled', transactionId: req.params.transactionId, canceledJobCount: out.canceledJobCount,
      message: `Event canceled. ${out.canceledJobCount} pending jobs removed.`,
    });
  });

  // ---- admin (API key) ----
  app.get('/admin/activity', apiKey, (req, res) => res.json(ctx.queries.activity(req.query)));
  app.get('/admin/notifications/:transactionId', apiKey, (req, res) => res.json(ctx.queries.notificationStatus(req.params.transactionId)));
  app.get('/admin/workflows', apiKey, (_req, res) => res.json({ workflows: ctx.workflows.list().filter((w) => !w.identifier.startsWith('__')) }));
  app.put('/admin/workflows/:identifier', apiKey, (req, res) => {
    if (req.params.identifier.startsWith('__')) throw new HttpError(400, 'BadRequest', "Identifiers starting with '__' are reserved.");
    res.json(ctx.workflows.upsert(req.params.identifier, req.body));
  });
  app.put('/admin/subscribers/:subscriberId', apiKey, (req, res) => {
    const body = isPlainObject(req.body) ? req.body : {};
    if (body.email != null && (typeof body.email !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(body.email))) {
      throw new HttpError(400, 'BadRequest', 'email is not a valid address.');
    }
    const s = ctx.subscribers.upsert(req.params.subscriberId, body);
    res.json({ subscriberId: s.external_id, email: s.email });
  });
  app.put('/admin/topics/:topic/subscribers', apiKey, (req, res) => {
    const added = ctx.subscribers.setTopicMembers(req.params.topic, (req.body || {}).subscriberIds);
    res.json({ topic: req.params.topic, added, members: ctx.subscribers.topicMembers(req.params.topic).length });
  });

  // ---- inbox (subscriber JWT) ----
  app.post('/inbox/session', (req, res, next) => {
    if (config.inboxSessionAuth === 'api_key') return apiKey(req, res, next);
    return next();
  }, (req, res) => {
    const body = req.body;
    if (!isPlainObject(body) || typeof body.organizationId !== 'string' || typeof body.subscriberId !== 'string' || !body.subscriberId) {
      throw new HttpError(400, 'BadRequest', 'organizationId and subscriberId are required.');
    }
    const sub = body.organizationId === config.organizationId && ctx.subscribers.byExternal(body.subscriberId);
    if (!sub) throw new HttpError(404, 'NotFound', 'Organization or subscriber not found.');
    const token = signJwt({ sub: sub.external_id, org: config.organizationId }, config.jwtSecret, {
      now: clock.now(), expiresInS: config.jwtExpiresIn,
    });
    res.json({ token, expiresIn: config.jwtExpiresIn, subscriberId: sub.external_id });
  });

  app.get('/inbox/notifications', subscriberAuth, (req, res) => res.json(ctx.queries.inbox(currentSubscriber(req), req.query)));
  app.patch('/inbox/notifications/:messageId/seen', subscriberAuth, (req, res) => {
    res.json(ctx.queries.markSeen(currentSubscriber(req), req.params.messageId));
  });

  app.get('/inbox/preferences', subscriberAuth, (req, res) => res.json(ctx.subscribers.getPreferences(currentSubscriber(req))));
  app.patch('/inbox/preferences', subscriberAuth, (req, res) => {
    const sub = currentSubscriber(req);
    const global = ctx.subscribers.setGlobalPreferences(sub, parsePrefPatch(req.body));
    res.json({ status: 'updated', subscriberId: sub.external_id, global });
  });
  app.patch('/inbox/preferences/:workflowId', subscriberAuth, (req, res) => {
    const sub = currentSubscriber(req);
    const patch = parsePrefPatch(req.body);
    if (!ctx.workflows.getByIdentifier(req.params.workflowId) || req.params.workflowId.startsWith('__')) {
      throw new HttpError(404, 'NotFound', 'Subscriber or workflow not found.');
    }
    const preferences = ctx.subscribers.setWorkflowPreferences(sub, req.params.workflowId, patch);
    res.json({ status: 'updated', subscriberId: sub.external_id, workflowId: req.params.workflowId, preferences });
  });

  app.post('/inbox/focus-mode/start', subscriberAuth, (req, res) => {
    const body = isPlainObject(req.body) ? req.body : {};
    const session = ctx.focus.start(currentSubscriber(req), body.duration ?? body.durationMinutes);
    res.status(201).json({ status: 'started', session });
  });
  app.post('/inbox/focus-mode/end', subscriberAuth, (req, res) => {
    const out = ctx.focus.end(currentSubscriber(req));
    res.json({ status: 'ended', ...out });
  });
  app.get('/inbox/focus-mode/status', subscriberAuth, (req, res) => res.json(ctx.focus.status(currentSubscriber(req))));
  app.get('/inbox/focus-mode/summary', subscriberAuth, (req, res) => {
    const id = req.query.sessionId === undefined ? undefined : Number(req.query.sessionId);
    if (id !== undefined && !Number.isInteger(id)) throw new HttpError(400, 'BadRequest', 'sessionId must be an integer.');
    res.json(ctx.focus.latestSummary(currentSubscriber(req), id));
  });

  app.use((req, _res, next) => next(new HttpError(404, 'NotFound', `No route for ${req.method} ${req.path}`)));

  app.use((err, req, res, _next) => {
    let status = 500;
    let body = { error: 'InternalServerError', message: 'Internal server error.' };
    if (err instanceof HttpError) {
      status = err.status;
      body = { error: err.error, message: err.message, ...err.extra };
    } else if (err && err.type === 'entity.parse.failed') {
      status = 400;
      body = { error: 'BadRequest', message: 'Malformed JSON body.' };
    } else if (err && err.type === 'entity.too.large') {
      status = 413;
      body = { error: 'PayloadTooLarge', message: 'Request body too large.' };
    } else {
      ctx.logger.error('unhandled request error', { method: req.method, path: req.path, error: err && err.message });
    }
    res.status(status).json({ ...body, timestamp: toIso(clock.now()) });
  });

  return app;
}

module.exports = { createApp };
