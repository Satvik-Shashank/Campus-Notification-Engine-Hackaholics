'use strict';

const crypto = require('node:crypto');
const { safeEqual, HttpError } = require('../util');

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** HS256 JWT (only that algorithm is ever accepted on verify). */
function signJwt(claims, secret, { now = Date.now(), expiresInS = 3600 } = {}) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const iat = Math.floor(now / 1000);
  const body = { ...claims, iat, exp: iat + expiresInS };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`;
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyJwt(token, secret, { now = Date.now() } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!header || header.alg !== 'HS256') return null;
  const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  if (!safeEqual(expected, parts[2])) return null;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return null;
  return claims;
}

const bearer = (req) => {
  const h = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
};

function requireApiKey(ctx) {
  return (req, _res, next) => {
    const token = bearer(req);
    if (!token || !safeEqual(token, ctx.config.apiKey)) {
      return next(new HttpError(401, 'Unauthorized', 'Invalid or missing API key.'));
    }
    req.apiKeyId = 'primary';
    return next();
  };
}

/** Subscriber identity comes only from the verified JWT subject, never from the request. */
function requireSubscriber(ctx) {
  return (req, _res, next) => {
    const claims = verifyJwt(bearer(req), ctx.config.jwtSecret, { now: ctx.clock.now() });
    if (!claims || !claims.sub || claims.org !== ctx.config.organizationId) {
      return next(new HttpError(401, 'Unauthorized', 'Invalid or expired token.'));
    }
    req.subscriberExternalId = claims.sub;
    return next();
  };
}

/** Fixed-window per-key limiter (in-memory, single process). */
function rateLimiter(ctx) {
  const windows = new Map();
  return (req, res, next) => {
    const key = req.apiKeyId || 'anon';
    const now = ctx.clock.now();
    const w = windows.get(key);
    if (!w || now - w.start >= 60000) {
      windows.set(key, { start: now, count: 1 });
      return next();
    }
    w.count += 1;
    if (w.count > ctx.config.rateLimitPerMin) {
      const retryAfter = Math.max(1, Math.ceil((w.start + 60000 - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      return next(new HttpError(429, 'TooManyRequests',
        `Rate limit exceeded. Max ${ctx.config.rateLimitPerMin} events per minute.`, { retryAfter }));
    }
    return next();
  };
}

module.exports = { signJwt, verifyJwt, requireApiKey, requireSubscriber, rateLimiter, bearer };
