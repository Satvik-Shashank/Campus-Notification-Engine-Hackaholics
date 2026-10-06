'use strict';

/**
 * Outbound provider protection (G6): a token bucket plus a circuit breaker, in front of every send.
 *
 *   acquire() -> { ok: true } | { ok: false, reason: 'throttled' | 'circuit_open', retryAt }
 *   onSuccess(), onFailure(err)   after a real send attempt
 *
 * A denied acquire means the provider was never called, so the engine reschedules the job WITHOUT
 * spending one of its delivery attempts. That keeps an outage or a burst from burning the 3-attempt
 * budget (the cascading failure described in GAPS G6).
 *
 * ratePerSec <= 0 disables the bucket; threshold <= 0 disables the breaker.
 */
function createProviderGuard({ clock, ratePerSec = 100, threshold = 5, cooldownMs = 30000, onTransition = () => {} }) {
  const capacity = Math.max(1, ratePerSec);
  let tokens = capacity;
  let refilledAt = clock.now();
  let pausedUntil = 0;

  let state = 'closed';
  let failures = 0;
  let openedAt = null;
  let probeInFlight = false;
  let lastError = null;
  let lastErrorAt = null;
  const counters = { sent: 0, failed: 0, throttled: 0, rejectedOpen: 0 };

  const transition = (to, reason) => {
    const from = state;
    state = to;
    onTransition({ from, to, reason, at: clock.now() });
  };

  function refill(now) {
    if (ratePerSec <= 0) return;
    const elapsed = Math.max(0, now - refilledAt);
    tokens = Math.min(capacity, tokens + (elapsed / 1000) * ratePerSec);
    refilledAt = now;
  }

  function acquire() {
    const now = clock.now();
    if (threshold > 0) {
      if (state === 'open') {
        if (now - openedAt >= cooldownMs) transition('half_open', 'cooldown elapsed');
        else {
          counters.rejectedOpen += 1;
          return { ok: false, reason: 'circuit_open', retryAt: openedAt + cooldownMs };
        }
      }
      if (state === 'half_open') {
        if (probeInFlight) {
          counters.rejectedOpen += 1;
          return { ok: false, reason: 'circuit_open', retryAt: now + Math.max(1000, Math.round(cooldownMs / 10)) };
        }
      }
    }
    if (now < pausedUntil) {
      counters.throttled += 1;
      return { ok: false, reason: 'throttled', retryAt: pausedUntil };
    }
    if (ratePerSec > 0) {
      refill(now);
      if (tokens < 1) {
        counters.throttled += 1;
        return { ok: false, reason: 'throttled', retryAt: now + Math.ceil(((1 - tokens) / ratePerSec) * 1000) };
      }
      tokens -= 1;
    }
    if (state === 'half_open') probeInFlight = true;
    return { ok: true };
  }

  function onSuccess() {
    counters.sent += 1;
    failures = 0;
    probeInFlight = false;
    if (state !== 'closed') transition('closed', 'probe succeeded');
  }

  /** Only transient failures say the provider is unhealthy; a permanent error proves it answered. */
  function onFailure(err) {
    counters.failed += 1;
    lastError = err && err.message ? err.message : String(err);
    lastErrorAt = clock.now();
    const transient = !(err && err.transient === false);
    if (err && err.status === 429 && Number.isFinite(err.retryAfterMs)) pausedUntil = clock.now() + err.retryAfterMs;
    const wasProbe = probeInFlight;
    probeInFlight = false;
    if (!transient) {
      if (state === 'half_open' && wasProbe) transition('closed', 'provider answered (permanent error)');
      failures = 0;
      return;
    }
    failures += 1;
    if (threshold <= 0) return;
    if (state === 'half_open') {
      openedAt = clock.now();
      transition('open', 'probe failed');
    } else if (state === 'closed' && failures >= threshold) {
      openedAt = clock.now();
      transition('open', `${failures} consecutive transient failures`);
    }
  }

  function snapshot() {
    refill(clock.now());
    return {
      breaker: {
        state, consecutiveFailures: failures, threshold, cooldownMs,
        openedAt: openedAt == null ? null : new Date(openedAt).toISOString(),
        reopensProbeAt: state === 'open' ? new Date(openedAt + cooldownMs).toISOString() : null,
      },
      rateLimit: {
        enabled: ratePerSec > 0, ratePerSec, tokens: ratePerSec > 0 ? Math.floor(tokens) : null, capacity,
        pausedUntil: pausedUntil > clock.now() ? new Date(pausedUntil).toISOString() : null,
      },
      counters: { ...counters },
      lastError,
      lastErrorAt: lastErrorAt == null ? null : new Date(lastErrorAt).toISOString(),
    };
  }

  /** Operator action: close the breaker and refill the bucket. */
  function reset() {
    failures = 0;
    probeInFlight = false;
    tokens = capacity;
    pausedUntil = 0;
    if (state !== 'closed') transition('closed', 'manual reset');
  }

  return { acquire, onSuccess, onFailure, snapshot, reset };
}

module.exports = { createProviderGuard };
