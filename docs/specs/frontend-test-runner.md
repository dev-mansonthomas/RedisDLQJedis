# Spec — Frontend test runner (Vitest via `@angular/build:unit-test`)

> **Status: planned, not started.** Written 2026-08-04 while shipping the work-queue demo modes /
> throughput counter; scheduled *after* that work lands. Written for agents: implement exactly this.
> Every claim below was verified against the installed packages on 2026-08-04 (Angular 21.0.0,
> `@angular/build` 21.0.0), not taken from documentation for another version — re-verify if the
> Angular major has moved since.

## Purpose

The repo has **no frontend test runner**: `angular.json` declares only `build`, `lint` and `serve`, so
`npm test` → `ng test` fails with "no builder". There are **0 `*.spec.ts` files**. Consequence today:
pure logic that *should* be unit-tested is verified by driving a real browser with a throwaway script —
e.g. `computeRate()` (the work-queue throughput counter) and the "at most 4 columns" grid constraint
were both checked by hand-measuring the rendered page. That is not repeatable and nothing prevents a
regression.

## Starting point (verified 2026-08-04)

| Fact | Evidence |
|------|----------|
| No `test` target | `jq '.projects[].architect \| keys' frontend/angular.json` → `["build","lint","serve"]` |
| No specs, no test config | `find frontend/src -name '*.spec.ts'` → 0 ; no `tsconfig.spec.json`, no karma/vitest/jest config |
| Builder **already installed** | `@angular/build@21.0.0` is a hard dependency of `@angular-devkit/build-angular@21.0.0`; `builders.json` exposes `unit-test` |
| Default runner is **Vitest** | `unit-test/schema.json` → `runner` enum `["karma","vitest"]`, `default: "vitest"` |
| Build target is compatible | build uses `@angular-devkit/build-angular:application` |
| **No `test.ts` / `tsconfig.spec.json` needed** | the builder generates the bootstrap itself: `getTestBed().initTestEnvironment(...)` + `zone.js/testing`, and injects `provideZoneChangeDetection()` because the build target's polyfills are `["zone.js"]` (`unit-test/runners/vitest/build-options.js`). `tsConfig` is optional in the schema |
| Required packages | `unit-test/runners/vitest/index.js` calls `checker.check('vitest')`, then `checkAny(['jsdom','happy-dom'])` for non-browser runs, `check('@vitest/coverage-v8')` when `coverage` is on, and for `browsers` one of `@vitest/browser-playwright` / `@vitest/browser-webdriverio` / `@vitest/browser-preview` |
| Karma is the wrong choice | still selectable, but deprecated upstream; do not start new work on it |

## Slice A — runner + first spec (the deliverable that unblocks everything)

**Scope of change (exhaustive):** `frontend/package.json`, `frontend/angular.json`,
one new `frontend/src/app/components/work-queue/work-queue.component.spec.ts`.

1. `npm i -D @angular/build vitest jsdom` — add `@angular/build` **explicitly**: referencing
   `@angular/build:unit-test` in `angular.json` while the package is only a transitive dependency is
   fragile.
2. Add the target. `buildTarget` defaults to this project's `build` target with the `development`
   configuration, so nothing else is required:
   ```json
   "test": { "builder": "@angular/build:unit-test" }
   ```
   `ng generate config vitest` additionally scaffolds a `vitest-base.config.ts` if native Vitest
   options are ever needed — not needed for slice A.
3. First spec: **`computeRate()`** (exported from `work-queue.component.ts` precisely so it is testable
   without a TestBed). Cases:
   - empty input → `0`
   - a single sample → `0` (a rate needs two points)
   - two samples 30 ms apart → **not** 66/s: the span is floored at 1 s, so ≤ 2/s
   - steady state: 50 samples spread over exactly 5 s with a 5 s window → `10`
   - decay: samples all older than the window → `0`
   - a sample outside the window is ignored (pass a mixed list, assert only the in-window ones count)

**Acceptance:** `npm test` runs and passes; the 6 cases above exist; `computeRate` is no longer
"verified by browser measurement only".

## Slice B — component specs

`TestBed` + `HttpTestingController` (`provideHttpClientTesting`), with `WebSocketService` replaced by a
stub whose `getEvents()` returns a `Subject<DLQEvent>`. Worth covering:

- `GET /streams` populates `streams` / `workers` / `demo`, and the mode's `producerSleepMs` moves
  `selectedSleep` onto an existing option (`closestSleepOption`).
- `PUT /demo-mode` on dropdown change; a 400 surfaces in `workerMessage`.
- A `MESSAGE_PRODUCED` event on `<doneStreamPrefix>N` increments `completedTotal`; one on the DLQ or the
  job stream does **not**.
- `POST /produce/burst` adds `burstSize` to `jobsProduced`.
- Pool bounds: a 409 leaves the pool untouched and sets `workerMessage`.

## Slice C — browser mode (optional but high value)

`browsers: ["ChromeHeadless"]` + `@vitest/browser-playwright` + `playwright`. The VM already has
chromium in `~/.cache/ms-playwright` and the playwright module resolves from the npx cache (see the
project memory note) — no download needed.

**Why it earns its keep:** the "**at most 4 workers per row**" rule
(`grid-template-columns: repeat(auto-fit, minmax(max(220px, calc(25% - 12px)), 1fr))`) is a *layout*
constraint. It was regressed once already — plain `minmax(220px, 1fr)` silently produced 5 columns at
1360 px and 6 at 1600 px — and jsdom cannot catch it because it does not do layout. A browser-mode spec
asserting `getComputedStyle(row).gridTemplateColumns.split(' ').length === 4` at 1360/1440/1600/1920 px
turns a hand measurement into a regression test.

## Two traps (verified, do not rediscover)

1. **`fakeAsync` / `tick` need `zone.js/plugins/vitest-patch` in the polyfills — do not add it.** In
   `@angular/build` 21.0.0 the `test` target has **no `polyfills` option** (checked in the schema; the
   angular.dev example showing one comes from `main`, a later version). The only way to load it would be
   via the **build** target's polyfills, which ships the patch in the application bundle. Use
   `vi.useFakeTimers()` instead — the Vitest-native idiom — for the throughput counter's 400 ms timer.
   Revisit only if a later Angular adds `polyfills` to the test target.
2. **jsdom has no WebSocket.** Never let a spec construct a real `SockJS`; stub `WebSocketService`. This
   is also the right isolation: the counting logic is what deserves testing, not SockJS.

## Out of scope

- The **76 pre-existing lint errors** (`npm run lint`). Unrelated; they do not block tests.
- Migrating anything to Karma, or adding Jest.
- E2E / Playwright Test. The throwaway scripts under the session scratchpad are not part of this.

## Adjacent, not included — there is no CI in this repo

Verified 2026-08-04: **no `.github/` directory at all**, so no workflow runs anything. Without CI a test
runner rots, and the `git-pr-merge` step documented in the global instructions waits on a CI that does
not exist. A workflow running `mvn clean test` + `npm run lint` + `npm test` is arguably more valuable
than slices B and C — but it is a separate decision (runner ordering, Docker availability for the
integration tests that currently *skip* without it). Tracked in `docs/TODO.md`.

## Effort

| Slice | Effort |
|-------|--------|
| A — runner + `computeRate` spec | 15–20 min |
| B — component specs | 1–2 h |
| C — browser mode + grid regression test | ~30 min |
| CI workflow (separate) | ~1 h |

## Next step

Slice A. Then update `CLAUDE.md` ("Frontend tests: still none (no runner configured)" becomes the real
command + count) and close the frontend half of the "No automated tests exist" finding in
`docs/TODO.md`.
