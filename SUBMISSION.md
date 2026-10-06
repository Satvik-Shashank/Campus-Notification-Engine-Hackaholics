# SUBMISSION

> The official SUBMISSION template (from the HACKBACK prerequisites PDF) was not available while this was built. This file records the facts; copy them into the official template if it differs.

## Project

- **Name:** Campus Notification Engine
- **Team:** Hackaholics
- **Card problem:** an exam timetable change must reach 30,000 students fast, without spamming them.
- **Original product reversed:** novuhq/novu at commit `cca284eb3375d7be648728a4e5e3552303d8d528` (per `docs/OBSERVATIONS.md`).
- **Spec:** the seven documents in `docs/` (frozen; not edited during the rebuild).

## How to run

```bash
cd campus-notification-engine
npm install
npm run seed
npm start          # http://localhost:3000
npm test           # 58 tests
```

Requires Node.js 22.5+ (built-in `node:sqlite`). No external services. Configuration: `.env.example` (names only; no secrets committed).

## Killer Tests

| # | Test | Result | Command |
|---|---|---|---|
| 1 | Ten events within five minutes become a single digest | passes | `npm run test:kt1` |
| 2 | A user who muted email gets in-app only | passes | `npm run test:kt2` |
| 3 | A failed send is retried without duplicates | passes | `npm run test:kt3` |

## Improvements chosen (from `docs/GAPS.md`)

1. **Fix: fail-closed inbound webhook signature verification.** Valid signature accepted, invalid or missing rejected with 401, unsupported or unconfigured verification rejected with 400. An explicit opt-in can record an unsupported webhook as unverified, and it is never applied. `npm run test:webhook`.
2. **Differentiator: Intelligent Focus Mode.** Time-boxed holding of non-critical notifications, critical bypass, correlation of related events, and a catch-up summary with redundancy suppression. `npm run test:focus`.

## Verification actually run

- `npm test`: 58 tests, 0 failures.
- `npm run lint` (eslint): clean.
- `npm run build`: every source file parses (there is no compile step).
- Manual smoke test of the real server with a SQLite file: three events to one subscriber became one digest email and one in-app message.
- Not done: load testing, multi-process workers, a real SMTP server, a browser walk-through of the UI (its script parses and the page is served, but it was not clicked through).

## AI assistance disclosure

Implementation was written by an AI coding agent, **Claude Code running Claude Sonnet 5.5** (`claude-sonnet-5-5`), working from the frozen `docs/` folder. Team members directed the work and are responsible for reviewing it.

## Clean-room statement

The original product's source was not opened, copied or imported during the rebuild. The only runtime dependency is Express (a general-purpose web library); persistence uses Node's built-in `node:sqlite`. No original-product packages are used.

## Known limitations

See "Known limitations" and "Implementation assumptions" in `README.md`.
