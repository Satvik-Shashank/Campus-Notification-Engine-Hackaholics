'use strict';

const crypto = require('node:crypto');
const { safeEqual, sha256Hex, HttpError } = require('../util');

/**
 * Inbound provider webhooks, FAIL-CLOSED.
 *
 * Verification outcomes:
 *   valid        -> signature checked and correct       -> event is applied
 *   invalid      -> signature present but wrong/stale   -> 401, nothing applied
 *   missing      -> no (usable) signature supplied      -> 401, nothing applied
 *   unsupported  -> no verifier exists for this provider-> 400, nothing applied
 *   unconfigured -> verifier exists but no secret set   -> 400, nothing applied
 * Only `valid` is ever trusted. The single exception is an explicit operator opt-in
 * (WEBHOOK_ALLOW_UNVERIFIED_<PROVIDER>=true) for `unsupported` providers: the request is recorded as
 * unverified and answered 202, but it is NEVER applied to delivery state.
 *
 * What this does NOT provide: replay protection for the generic scheme (the mailgun-style scheme
 * checks a timestamp window; it does not track tokens), and no verifier for ECDSA-signed providers
 * such as SendGrid (those stay `unsupported`, i.e. rejected).
 */

const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

const SCHEMES = {
  // Header "x-webhook-signature: sha256=<hex>", HMAC-SHA256 of the raw request body.
  'hmac-sha256-body': ({ rawBody, headers, secret }) => {
    const header = headers['x-webhook-signature'];
    if (!header) return 'missing';
    const m = /^sha256=([0-9a-f]{64})$/i.exec(String(header).trim());
    if (!m) return 'invalid';
    return safeEqual(m[1].toLowerCase(), hmacHex(secret, rawBody)) ? 'valid' : 'invalid';
  },
  // Body field signature = { timestamp, token, signature }, HMAC-SHA256 of timestamp + token.
  'timestamp-token': ({ body, secret, now, toleranceS }) => {
    const sig = body && body.signature;
    if (!sig || !sig.timestamp || !sig.token || !sig.signature) return 'missing';
    const ts = Number(sig.timestamp);
    if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > toleranceS) return 'invalid';
    return safeEqual(String(sig.signature).toLowerCase(), hmacHex(secret, `${sig.timestamp}${sig.token}`)) ? 'valid' : 'invalid';
  },
};

// Provider -> scheme. `null` means "known provider, no verifier implemented".
const PROVIDERS = { generic: 'hmac-sha256-body', mailgun: 'timestamp-token', sendgrid: null };

const EVENT_MAP = { delivered: 'delivered', bounce: 'bounced', bounced: 'bounced', dropped: 'dropped', deferred: 'deferred' };

function normalizeEvents(body) {
  const list = Array.isArray(body && body.events) ? body.events : [body];
  return list.filter((e) => e && typeof e === 'object').map((e) => {
    const data = e['event-data'] || e;
    return {
      type: EVENT_MAP[String(data.event || '').toLowerCase()] || null,
      messageId: data.messageId || (data.message && data.message.headers && data.message.headers['message-id']) || null,
    };
  });
}

function createWebhooks(ctx) {
  const { db, clock, config } = ctx;

  const record = (provider, verification, outcome, applied, rawBody) => db.run(
    `INSERT INTO webhook_events (provider, verification, outcome, applied, body_sha256, created_at) VALUES (?,?,?,?,?,?)`,
    provider, verification, outcome, applied, sha256Hex(rawBody), clock.now(),
  );

  function applyEvents(body) {
    let applied = 0;
    let ignored = 0;
    for (const e of normalizeEvents(body)) {
      const msg = e.type && e.messageId ? db.get('SELECT * FROM messages WHERE provider_message_id = ?', e.messageId) : null;
      if (!msg) {
        ignored += 1;
        continue;
      }
      db.run(
        `UPDATE messages SET provider_status = ?, status = CASE WHEN ? IN ('bounced','dropped') THEN 'delivery_failed' ELSE status END,
           updated_at = ? WHERE id = ?`,
        e.type, e.type, clock.now(), msg.id,
      );
      const n = db.get('SELECT transaction_id, workflow_id FROM notifications WHERE id = ?', msg.notification_id);
      ctx.activity.log({
        transactionId: n.transaction_id, notificationId: msg.notification_id, jobId: msg.job_id, subscriberId: msg.subscriber_id,
        workflowId: n.workflow_id, stepType: 'email', event: 'provider_status', status: e.type === 'delivered' ? 'success' : 'failure',
        message: `Provider reported '${e.type}' (verified webhook)`,
      });
      applied += 1;
    }
    return { applied, ignored };
  }

  return {
    PROVIDERS,

    /** Pure verification decision, exposed for tests. */
    verify(provider, { rawBody, headers, body }) {
      if (!(provider in PROVIDERS) || PROVIDERS[provider] === null) return 'unsupported';
      const secret = config.webhookSecrets[provider];
      if (!secret) return 'unconfigured';
      return SCHEMES[PROVIDERS[provider]]({ rawBody, headers, body, secret, now: clock.now(), toleranceS: config.webhookToleranceS });
    },

    handle(provider, { rawBody, headers, body }) {
      if (!/^[a-z0-9_-]{1,40}$/.test(provider)) throw new HttpError(400, 'BadRequest', 'Invalid provider name.');
      const verification = this.verify(provider, { rawBody, headers, body });

      if (verification === 'valid') {
        const result = db.tx(() => {
          const r = applyEvents(body);
          record(provider, verification, 'accepted', r.applied, rawBody);
          return r;
        });
        return { status: 200, body: { status: 'accepted', verified: true, ...result } };
      }

      if (verification === 'invalid' || verification === 'missing') {
        record(provider, verification, 'rejected', 0, rawBody);
        throw new HttpError(401, 'Unauthorized', verification === 'missing'
          ? 'Webhook signature is missing.' : 'Webhook signature is invalid.', { verification });
      }

      // unsupported / unconfigured
      if (verification === 'unsupported' && config.webhookAllowUnverified[provider] === true) {
        record(provider, 'unverified', 'recorded_unverified', 0, rawBody);
        return { status: 202, body: { status: 'unverified', verified: false, applied: 0, message: 'Recorded as unverified; not applied.' } };
      }
      record(provider, verification, 'rejected', 0, rawBody);
      throw new HttpError(400, 'WebhookVerificationUnavailable', verification === 'unsupported'
        ? `Signature verification is not supported for provider '${provider}'; webhook rejected.`
        : `No webhook secret configured for provider '${provider}'; webhook rejected.`, { verification });
    },
  };
}

module.exports = { createWebhooks, PROVIDERS, SCHEMES };
