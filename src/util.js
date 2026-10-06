'use strict';

const crypto = require('node:crypto');

const sha256Hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Constant-time string comparison that tolerates different lengths. */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const toIso = (ms) => (ms == null ? null : new Date(ms).toISOString());

const parseJson = (text, fallback = null) => {
  if (text == null) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

class HttpError extends Error {
  constructor(status, error, message, extra = {}) {
    super(message);
    this.status = status;
    this.error = error;
    this.extra = extra;
  }
}

/** `{{field}}` substitution; unknown fields render as empty text. */
function renderTemplate(template, data) {
  return String(template ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key) => {
    const v = key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), data);
    return v == null ? '' : String(v);
  });
}

module.exports = { sha256Hex, safeEqual, toIso, parseJson, HttpError, renderTemplate };
