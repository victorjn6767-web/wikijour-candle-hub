# wikijour-candle-hub

Standalone experiments for a server-side M1 candle pipeline: download Dukascopy day files, decode, validate, encode to a compact month format.

**This repository contains code only.** It never stores market data, and CI fails if a data-like file or a secret-looking string is committed (`scripts/guard.js`). Output goes to storage outside GitHub; experiment runs only print aggregate statistics.

## Layout
- `src/dukascopy.js` — day-file URL, LZMA decode (`xz`), record parser, fetch with retry and optional proxy
- `src/wjm1.js` — month file codec; **version 1 is frozen** (`test/v1-frozen.test.js`), version 2 is a candidate that is only measured
- `scripts/fetch.js` — resumable downloader (state kept on the runner, not in Git)
- `scripts/analyze.js` — validation, filler/session/DST analysis, size measurements
- `test/` — unit tests and whole-run tests (resume, validation, optional proxy, circuit breaker) against a local mock server
- `scripts/guard.js` — fails the build on data files, large files or secret-like strings
- `.github/workflows/exp0.yml` — manual experiment run

## Secrets
Only GitHub Actions Secrets, never files: `DK_PROXY_URL` (optional pass-through address used when the direct source throttles). Nothing else is needed for the experiment.

## Data notes
Dukascopy publishes market data under its own terms; check them before redistributing any data or using it beyond personal evaluation.

## Download rules
- Direct download first. The proxy (`DK_PROXY_URL`) is optional: with no secret, or a dead proxy, direct download keeps working.
- A day counts as complete only if the file decodes and every candle passes sanity checks (grid, day bounds, OHLC, volume); HTTP 200 alone is not enough, and a tiny or empty proxy answer is never treated as "no data".
- The proxy circuit breaker lives in one process only (3 consecutive days with a dead proxy); the next step or run starts with the proxy enabled again.
- Direct and proxy statistics are reported separately.
