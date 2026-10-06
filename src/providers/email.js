'use strict';

/**
 * Email provider contract:
 *   send({ to, subject, body, idempotencyKey, from }) -> Promise<{ providerMessageId }>
 * Failures must be thrown as ProviderError so the engine can tell transient from permanent.
 */
class ProviderError extends Error {
  constructor(message, { transient = true, status = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.transient = transient;
    this.status = status;
    /** For 429 responses: how long the provider asked us to wait. */
    this.retryAfterMs = retryAfterMs;
  }
}

/** Statuses a provider may return that are worth retrying. */
const isTransientStatus = (status) => status === 429 || (status >= 500 && status < 600);

/**
 * Local provider used when no SMTP is configured. Nothing leaves the machine.
 * It mimics provider-side idempotency: the same key yields the same message id and is recorded once.
 */
function createConsoleProvider({ logger } = {}) {
  const seen = new Map();
  return {
    name: 'console',
    sent: seen,
    async send({ to, subject, idempotencyKey }) {
      if (!seen.has(idempotencyKey)) {
        seen.set(idempotencyKey, { providerMessageId: `console_${idempotencyKey.slice(0, 16)}`, to, subject });
        if (logger) logger.info('email (console provider)', { to, subject, idempotencyKey });
      }
      return { providerMessageId: seen.get(idempotencyKey).providerMessageId };
    },
  };
}

/**
 * SMTP provider. nodemailer is loaded lazily and only when SMTP_HOST is set; it is NOT a declared
 * dependency, install it yourself to use this path. SMTP has no idempotency-key support, so the key
 * is only attached as a header and the engine's own message table is the dedup guard.
 * This adapter has not been exercised against a real SMTP server in this repo.
 */
function createSmtpProvider(smtp) {
  let transport;
  return {
    name: 'smtp',
    async send({ to, subject, body, idempotencyKey, from }) {
      if (!transport) {
        const nodemailer = require('nodemailer');
        transport = nodemailer.createTransport({
          host: smtp.host,
          port: smtp.port,
          auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
        });
      }
      try {
        const info = await transport.sendMail({
          from: from || smtp.from,
          to,
          subject,
          text: body,
          headers: { 'X-Idempotency-Key': idempotencyKey },
        });
        return { providerMessageId: info.messageId };
      } catch (err) {
        const status = err.responseCode || null;
        const permanent = status && status >= 500 && status < 600 && status !== 503;
        throw new ProviderError(err.message, { transient: !permanent, status });
      }
    },
  };
}

function createEmailProvider(config, logger) {
  return config.smtp.host ? createSmtpProvider(config.smtp) : createConsoleProvider({ logger });
}

/**
 * DEMO_MODE only: wraps a provider so an operator can make the next N sends fail on purpose
 * (to show KT3 retries or the dead-letter queue live). Never installed outside demo mode.
 */
function createFaultInjector(inner) {
  const armed = [];
  return {
    name: `${inner.name}+faults`,
    inner,
    arm(count, kind = 'transient') {
      for (let i = 0; i < count; i += 1) armed.push(kind);
      return armed.length;
    },
    clear() {
      armed.length = 0;
    },
    pending: () => armed.length,
    async send(msg) {
      const kind = armed.shift();
      if (kind === 'transient') throw new ProviderError('injected failure: provider returned 500', { transient: true, status: 500 });
      if (kind === 'permanent') throw new ProviderError('injected failure: mailbox does not exist (550)', { transient: false, status: 550 });
      return inner.send(msg);
    },
  };
}

module.exports = {
  ProviderError, isTransientStatus, createConsoleProvider, createSmtpProvider, createEmailProvider, createFaultInjector,
};
