'use strict';

const DEFAULT_API_KEY = 'campus-admin-api-key-change-in-production';
const DEFAULT_JWT_SECRET = 'campus-jwt-secret-change-in-production';

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function list(value, fallback) {
  if (!value) return fallback;
  const parts = value.split(',').map((s) => Number.parseInt(s.trim(), 10)).filter(Number.isFinite);
  return parts.length ? parts : fallback;
}

/** Build configuration from an env-like object. Overrides win (used by tests). */
function loadConfig(env = process.env, overrides = {}) {
  const webhookSecrets = {};
  const allowUnverified = {};
  for (const [key, value] of Object.entries(env)) {
    let m = /^WEBHOOK_SECRET_(.+)$/.exec(key);
    if (m && value) webhookSecrets[m[1].toLowerCase()] = value;
    m = /^WEBHOOK_ALLOW_UNVERIFIED_(.+)$/.exec(key);
    if (m) allowUnverified[m[1].toLowerCase()] = value === 'true';
  }
  return {
    port: int(env.PORT, 3000),
    nodeEnv: env.NODE_ENV || 'development',
    dbPath: env.DB_PATH || './data/campus.db',
    apiKey: env.API_KEY || DEFAULT_API_KEY,
    jwtSecret: env.JWT_SECRET || DEFAULT_JWT_SECRET,
    jwtExpiresIn: int(env.JWT_EXPIRES_IN, 3600),
    inboxSessionAuth: env.INBOX_SESSION_AUTH === 'public' ? 'public' : 'api_key',
    rateLimitPerMin: int(env.RATE_LIMIT_PER_MIN, 100),
    organizationId: env.ORGANIZATION_ID || 'campus-org',
    environmentId: env.ENVIRONMENT_ID || 'campus-env',
    smtp: {
      host: env.SMTP_HOST || '',
      port: int(env.SMTP_PORT, 587),
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
      from: env.EMAIL_FROM || 'noreply@campus.edu',
    },
    digestWindowMs: int(env.DIGEST_WINDOW_MS, 300000),
    emailMaxAttempts: int(env.EMAIL_MAX_ATTEMPTS, 3),
    emailBackoffMs: list(env.EMAIL_BACKOFF_DELAYS, [1000, 5000, 15000]),
    workerTickMs: int(env.WORKER_TICK_MS, 500),
    jobLockTimeoutMs: int(env.JOB_LOCK_TIMEOUT_MS, 90000),
    fanoutChunkSize: 100,
    fanoutMaxAttempts: 5,
    dedupWindowMs: 24 * 60 * 60 * 1000,
    webhookSecrets,
    webhookAllowUnverified: allowUnverified,
    webhookToleranceS: int(env.WEBHOOK_TIMESTAMP_TOLERANCE_S, 300),
    focusMaxHours: int(env.FOCUS_MODE_MAX_HOURS, 24),
    ...overrides,
  };
}

/** Refuse to boot in production with the shipped placeholder secrets. */
function assertSafeForProduction(config) {
  if (config.nodeEnv !== 'production') return;
  if (config.apiKey === DEFAULT_API_KEY || config.jwtSecret === DEFAULT_JWT_SECRET) {
    throw new Error('Refusing to start in production with placeholder API_KEY/JWT_SECRET');
  }
}

module.exports = { loadConfig, assertSafeForProduction, DEFAULT_API_KEY, DEFAULT_JWT_SECRET };
