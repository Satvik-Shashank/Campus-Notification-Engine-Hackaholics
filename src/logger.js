'use strict';

const SECRET_KEYS = /secret|password|pass|token|signature|authorization|apikey|api_key/i;

function scrub(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta || {})) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : v;
  return out;
}

/** Tiny structured logger. Secret-looking keys are redacted; silent when level is 'silent'. */
function createLogger(level = process.env.LOG_LEVEL || 'info') {
  const order = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
  const threshold = order[level] ?? 20;
  const emit = (lvl, msg, meta) => {
    if (order[lvl] < threshold) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...scrub(meta) });
    (lvl === 'error' || lvl === 'warn' ? console.error : console.log)(line);
  };
  return {
    debug: (m, x) => emit('debug', m, x),
    info: (m, x) => emit('info', m, x),
    warn: (m, x) => emit('warn', m, x),
    error: (m, x) => emit('error', m, x),
  };
}

module.exports = { createLogger };
