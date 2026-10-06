# SUBMISSION

> The official SUBMISSION template (from the HACKBACK prerequisites PDF) was not available while this was built. This file records the facts; copy them into the official template if it differs.

## Project

- **Name:** Concourse, Campus Notification Engine
- **Team:** Hackaholics
- **Card:** Campus Notification Engine (Real-time & Infra). An exam timetable change must reach 30,000 students fast, without spamming them.
- **Original product reversed:** novuhq/novu at commit `cca284eb3375d7be648728a4e5e3552303d8d528` (per `docs/OBSERVATIONS.md`).
- **Spec:** the seven documents in `docs/`, frozen and not edited during the rebuild.

## How to run

```bash
cd campus-notification-engine
npm install
npm run demo        # seeds SRM University → http://localhost:3000
```

Requires Node.js 22.5+. No external services. Production-style run: `npm run seed && npm start`. Configuration: `.env.example` (names only; no secrets committed).

## Killer Tests

| # | Test | Automated | Live (Demo Lab) |
|---|---|---|---|
| 1 | Ten events within five minutes become a single digest | `npm run test:kt1`: pass | card "Killer Test 1": PASS |
| 2 | A user who muted email gets in-app only | `npm run test:kt2`: pass | card "Killer Test 2": PASS |
| 3 | A failed send is retried without duplicates | `npm run test:kt3`: pass | card "Killer Test 3": PASS |

## Improvements (from `docs/GAPS.md`, final two)

1. **Fix: fail-closed inbound webhook signature verification.** Valid → 200 and applied. Invalid or missing → 401, nothing applied. Unsupported or unconfigured → 400, nothing applied. An explicit opt-in records the webhook as unverified and still never applies it. `npm run test:webhook`, Demo Lab card "Fix".
2. **Differentiator: Intelligent Focus Mode.** Holds non-critical notifications, lets critical ones through, correlates related events, suppresses facts the student already knows, and delivers one catch-up. `npm run test:focus`, Demo Lab card "Differentiator".

## Other gaps closed (G1–G8 in `docs/GAPS.md`)

G1 retry, G2 idempotent re-execution, G3/G4 resumable fan-out, G5 unique transactionId: each covered by a named test in `tests/gaps.test.js`. **G6** (rate limiter + circuit breaker), **G7** (dead-letter queue with safe retry) and **G8** (cross-workflow digest) were implemented in this pass and also have live Demo Lab cards.

## Verification actually run (2026-10-06)

- `npm test`: 83 tests, 0 failures. Real engine, SQLite, HTTP and WebSocket; only the clock and email provider are substituted.
- `npm run lint`: clean. `npm run typecheck:web`: clean (TypeScript strict).
- `npm run test:e2e` (headless Edge): 35/35. Admin composes to a course and the student receives it live; digest detail, actions, search, preferences, topics, Focus Mode, lifecycle inspector, dashboard; all 8 internal verification cards PASS; zero browser console errors.
- `npm run bench -- 30000`: 30,000 students. API accept 2 ms; all 30,000 emails and in-app messages delivered in 38.0 s (127 ms per 100 students); 0 duplicate emails.
- `npm run test:crash`: server SIGKILLed mid-delivery with 3,000 students, then restarted. 3,000/3,000 got exactly one email and one in-app record, 0 lost. The one in-flight email was re-sent with the same idempotency key (see README limitations).
- Not done: Docker image build, real SMTP server, multi-process workers, a manual visual review by a person.

## AI assistance disclosure

Implementation was written by an AI coding agent, **Claude Code**, working from the frozen `docs/` folder and the team's implementation plan. The engine was built by Claude Sonnet 5.5 (`claude-sonnet-5-5`). The product-completion pass (UI, G6–G8, WebSocket, benchmarks) was done by Claude Opus 5.5 (`claude-opus-5-5`). Team members directed the work and are responsible for reviewing it.

## Clean-room statement

The original product's source was not opened, copied or imported during the rebuild. Runtime dependencies are Express and `ws` (general-purpose libraries); persistence uses Node's built-in `node:sqlite`. The UI uses React, React Router, Tailwind and Fontsource fonts. No original-product packages, names, logos or styling are used. "Concourse" and its visual identity are our own.

## Known limitations

See "Known limitations" and "Implementation assumptions" in `README.md`.
