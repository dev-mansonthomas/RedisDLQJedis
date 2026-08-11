# Plan — blog-workqueue-post (test-first)

> Spec: [`blog-workqueue-post.md`](blog-workqueue-post.md). Brief:
> [`brief-blog-workqueue-post.md`](../product/brief-blog-workqueue-post.md). Branch: a fresh branch off
> `main` **after slice A is merged** (the post links `WorkQueueService` line ranges and claims the page
> can add/remove/kill workers; the `blog-workqueue-v1` tag must be cuttable from `main`).
> Slice A is delivered and green — [`work-queue-dynamic-workers.md`](work-queue-dynamic-workers.md).

## Toolchain check (run 2026-08-11 — no session restart needed, unlike post #1)

`go` · `dotnet 10.0.302` · `cargo/rustc 1.97.0` · `uv 0.12.3` · `node 24.16` · `mvn 3.9.16` ·
`redis-cli 8.8.0` · `shellcheck` · `docker 29.5.2` · `jq 1.7` — all on PATH. All six samples can be
written and **actually run** in one session.

## Verified client APIs (do not re-guess)

Versions are the ones post #1's samples already pin (`blog/dlq-redis-streams/samples/*`) — reuse them
so the two posts don't disagree: Jedis **7.5.3**, `redis>=8` (redis-py), node-redis **^6.1.0**,
go-redis **v9.21.0**, NRedisStack **0.13.1**, Rust `redis` **0.32**. The `FCALL` half of every sample
is already proven by post #1 — **copy those call sites**, don't re-derive them.

What is *new* in this post is the **blocking read**. Verified 2026-08-11:

| Client | Blocking `XREADGROUP` | Source |
|---|---|---|
| Jedis 7.5.3 | `XReadGroupParams.xReadGroupParams().count(1).block(1000)` — and `.claim(long)` exists as a typed option | `javap` on the pinned jar (ground truth, not docs) |
| redis-py | `xreadgroup(group, consumer, {stream: '>'}, count=1, block=1000)` | confirm by running (task 5) |
| node-redis 6 | `xReadGroup(group, consumer, {key, id:'>'}, { COUNT: 1, BLOCK: 1000 })` | confirm by running (task 5) |
| go-redis v9 | `XReadGroup(ctx, &redis.XReadGroupArgs{Group, Consumer, Streams: []string{s, ">"}, Count: 1, Block: time.Second})` | confirm by running (task 6) |
| Rust `redis` 0.32 | `StreamReadOptions::default().group(g, c).count(1).block(1000)` → `xread_options` | confirm by running (task 6) |
| **NRedisStack / StackExchange.Redis** | **⚠ no blocking read at all** | **Context7, verified** |

**The C# finding, and what it costs.** StackExchange.Redis deliberately ships **no blocking
commands** — its own docs: *"Due to its multiplexing nature, StackExchange.Redis does not offer
blocking pop commands … as they could stall the entire multiplexer"* — and `StreamReadGroup` exposes
no `BLOCK`. So the C# sample **cannot** be `BLOCK`-shaped like the other five.

Decision, to be written into the spec as task 0's second output: **the C# sample polls** —
`StreamReadGroup(COUNT 1)` + a 1 s sleep when empty — with a header comment naming the reason, and
the post gains **one sentence** noting that one of the six clients multiplexes and therefore polls (or
gets woken by pub/sub) instead of blocking. Rejected alternative: forcing `db.Execute("XREADGROUP",
…, "BLOCK", "1000", …)`, which works around the design the library chose on purpose and risks
`SyncTimeout` flakiness. The deviation is *useful* content: it is a real constraint a reader will hit,
and it reinforces the post's own "the demo polls, here's why" paragraph.

## Ground truth to reuse (do not re-derive)

- **`samples/setup.sh`**: post #1's (`blog/dlq-redis-streams/samples/setup.sh`, 82 lines) is the
  template — discover-or-start Redis, `FUNCTION LOAD REPLACE`, `XGROUP CREATE` tolerating
  `BUSYGROUP`, **port on stdout / logs on stderr**. Change: names, `BLOG_WQ_PORT`, container
  `blog-workqueue-redis`, plus the seed step (new).
- **`verify.sh`**: post #1's (175 lines) is the template — `ok`/`ko`/`verdict`, `start_redis`,
  `trap cleanup EXIT`, the `verify:begin/end` block extractor (`awk`), `chk_wordcount` /`chk_links`
  /`chk_forbidden` /`chk_img` are near-copies (word range and tag string change).
- **Sample headers**: the QUICKSTART convention shipped in PR #18 — see
  `blog/dlq-redis-streams/samples/node/dlq-example.mjs` lines 1-22. Post #2 adds a **second**
  one-liner (the `worker-2` terminal) and drops the 60-second primer to a link.
- **`read_claim_or_dlq`** is unchanged and already documented by post #1. Recall in ≤ 3 lines.
- Payload fields are `jobId` / `processingType` / `createdAt` (`WorkQueueService.produceJob`);
  the burst's ratio is 1 `Error` in 10 (`BURST_ERROR_EVERY`).

## The test harness *is* the test suite

There is no unit-test framework here: the acceptance criteria are shell checks, so `verify.sh` plays
the role of the failing test, and it is written **first** (task 1). One command:

```bash
./blog/work-queue-redis-streams/verify.sh     # own throwaway redis:8.8-alpine, port 6398
```

Its 13 checks map 1:1 onto the spec's acceptance boxes. **Done** for the whole feature = every check
PASS, plus `luacheck lua/` 0 errors and `mvn clean test` green (both prove the post changed no demo
code).

## Ordered tasks

### T0 — Coherence audit + spec amendment (blocking; research, not TDD)

Two outputs, both before a line of the post is written.

1. **Audit** the four items the spec lists: `README.md`'s work-queue mentions (still a fixed 4-worker
   pool?), `docs/specs/work-queue.md` ↔ `WorkQueueService` after slice A, `lua/stream_utils.lua` ↔ the
   description post #1 gives of `read_claim_or_dlq` (if the two posts describe it differently, one is
   wrong), and the `/work-queue` page's info text ↔ the numbers the post will pin.
2. **Amend the spec** with the C# deviation above (samples contract + one post sentence + the
   `chk_sample_csharp` expectation, which must not demand a `BLOCK`).

**Gate:** any demo-code change → stop, explain, wait for the author. **Done when** the audit report is
in the conversation and the spec no longer claims all six samples block.

### T1 — RED: write `verify.sh` with all 13 checks

Create `blog/work-queue-redis-streams/verify.sh` (post #1's as the skeleton) with:
`chk_shellcheck`, `chk_setup`, `chk_walkthrough`, `chk_distribution`, `chk_recovery`,
`chk_sample_{java,python,node,go,csharp,rust}`, `chk_wordcount` (**1600–1900**), `chk_links`
(**`blog-workqueue-v1`**), `chk_forbidden`, `chk_img`, `chk_coherence`, `chk_no_xautoclaim`.

Run it. Expected: `chk_shellcheck` PASS, **everything else FAIL** — that list is the to-do, and every
later task is "turn one line from FAIL to PASS". A missing toolchain must be a `ko` naming the tool,
never a silent skip.

`chk_coherence` is the drift guard: assert the post's prose contains `2000` and `5000` **and** that
`src/main/java/com/redis/patterns/service/WorkQueueService.java` still matches
`SLOW("Slow", 2000, 5000`.

### T2 — GREEN `chk_setup`: `samples/setup.sh`

Adapt post #1's script: `BLOG_WQ_PORT`, container `blog-workqueue-redis`, `XGROUP CREATE
jobs.imageProcessing.v1 jobs-group $ MKSTREAM`, then the **new** seed step — `SEED_JOBS` (default 10)
`XADD`s, every 10th `processingType=Error`, **only when `XLEN` is 0** so a re-run doesn't double the
backlog. Port on stdout, logs on stderr, `shellcheck`-clean.
→ `chk_shellcheck` + `chk_setup` PASS.

### T3 — GREEN `chk_walkthrough` / `chk_distribution` / `chk_recovery`: the walkthrough **before** any prose

Create `index.md` with the section skeleton but author **only** sections 5 and 7 (split the load /
when a worker dies), because they are the post's two load-bearing claims.

The design constraint that makes this the interesting task: the narrative is **two terminals**, the
harness replays **one shell**. So each claim gets both forms:

- *shown to the reader, outside the markers*: two terminals each running
  `redis-cli XREADGROUP GROUP jobs-group worker-N COUNT 1 BLOCK 1000 STREAMS … >`;
- *inside `<!-- verify:begin/end -->`*: the same claim as a single-shell sequence — read as
  `worker-1`, then as `worker-2`, assert **disjoint** ids (never a split ratio: `XREADGROUP` gives
  each entry to whoever asks first, so a fast consumer legitimately takes more); then leave one entry
  un-ACKed as `worker-2`, `sleep 5` (`minIdle` = 5000), `FCALL` as `worker-1` and show it comes back,
  with `XINFO CONSUMERS` proving `worker-2` is **still in the group**.

Never `BLOCK 0` in a replayed block. End state the harness asserts: `XPENDING` summary 0, DLQ `XLEN` 1.
→ those three checks PASS. The post's core is now machine-replayed before it is styled.

### T4 — GREEN `chk_sample_java`: the reference sample

`samples/java/pom.xml` (Jedis 7.5.3) + `src/main/java/WorkQueueWorker.java`, establishing the shape the
other five copy:

- `args[0]` = consumer name (default `worker-1`); `REDIS_URL`; `SAMPLE_EXIT_AFTER_IDLE_POLLS`
  (unset → forever).
- `xreadGroup(…, xReadGroupParams().count(1).block(1000), …)` hot path; every other iteration a
  `fcall("read_claim_or_dlq", …, minIdle=5000, count=1, maxDeliver=2)` sweep.
- **Both replies feed one handler** — the sweep's step 3 is itself an `XREADGROUP >`, so treating it
  as reclaim-only leaks a read-but-never-ACKed job. This is risk #1 of the spec.
- Handler: print `job <jobId> -> <consumer>`, sleep 2000 ms, then `OK` → `XADD jobs.done.<consumer>`
  + `XACK` (comment the non-atomicity → at-least-once), `Error` → **no ACK**.
- **No signal handler** — Ctrl-C mid-job leaving the entry in the PEL *is* the demo; comment it so
  nobody "fixes" it.

**REFACTOR** once green: extract the exact wording of the shared header/comments into this sample as
the canonical copy, since the next five are translations of it.

### T5 — GREEN `chk_sample_python`, `chk_sample_node`

Translate T4. Confirm the two option shapes from the table by **running** them (`block=1000` /
`{ COUNT, BLOCK }`); if either differs, fix the plan's table in place rather than inventing an API.

### T6 — GREEN `chk_sample_go`, `chk_sample_rust`

Same, with `XReadGroupArgs{Block: time.Second}` and `StreamReadOptions…block(1000)`. Rust: keep the
`redis::cmd("FCALL")` form post #1 proved for the sweep.

### T7 — GREEN `chk_sample_csharp` ⚠ the deviating one

`StreamReadGroup(…, count: 1)` + 1 s sleep when empty (no `BLOCK` — T0's amendment), sweep via
`db.Execute("FCALL", …)` exactly as post #1's C# sample does. Write it **before** the prose that
describes it, so the sentence about it is written from a program that ran.

### T8 — GREEN `chk_img`: the diagram

`img/work-queue-flow.excalidraw` + exported `.png` via the `redis-excalidraw-diagrams` skill:
producer → `jobs.imageProcessing.v1` → **one** group → N workers → per-worker done streams, dashed DLQ
arrow labelled "post #1". The "one group, N consumers" part must be visually unmistakable — it is the
single idea the post exists to convey. Non-empty alt text in `index.md`.

### T9 — GREEN `chk_wordcount` / `chk_links` / `chk_forbidden` / `chk_no_xautoclaim` / `chk_coherence`

Write sections 1–4, 6, 8–12 around the already-verified 5 and 7, per the spec's normative plan.
Budget discipline: DLQ ≤ 3 sentences, `read_claim_or_dlq` ≤ 3 lines, batching and retention **one
sentence each**. Include the `minIdle >= 2 × work` paragraph (section 9) and exactly **one** inline
excerpt (the Jedis `fcall` from `processNextJob`) + its pinned permalink. Wrap the closing section in
`<!-- forbidden-exempt:begin/end -->`. **REFACTOR**: cut to 1600–1900 words.

### T10 — Docs & publishing metadata

`blog/PUBLISHING.md`: add the `blog-workqueue-v1` / `work-queue-redis-streams` path list.
`CLAUDE.md`: the blog tree in "Layout". `docs/TODO.md`: anything the audit surfaced.

### T11 — Full gate & ship

```bash
./blog/work-queue-redis-streams/verify.sh                 # 13/13 PASS
luacheck lua/ --globals redis cjson cmsgpack bit          # 0 errors — no Lua touched
mvn clean test                                            # 93/93 — no demo change
```

Then `/ship`, and propose the commits **split like post #1**: one PR for
walkthrough + samples + harness (T1-T8), one for the prose (T9-T10). Slice C (`index.fr.md`) is a
third PR, after the English is validated. The author pushes `blog-workqueue-v1` from the host.

## Files: create vs modify

**Create** — everything under `blog/work-queue-redis-streams/`: `verify.sh`, `index.md`,
`img/work-queue-flow.{excalidraw,png}`, `samples/setup.sh`, and
`samples/{java,python,node,go,csharp,rust}/*` (manifest + one source file each).

**Modify** — `docs/specs/blog-workqueue-post.md` (T0's C# amendment), `blog/PUBLISHING.md`,
`CLAUDE.md`, `docs/TODO.md`, and this plan if a client API differs from the table.

**Untouched:** `lua/stream_utils.lua`, every `src/main/java/**`, the frontend, post #1's directory.
A change to any of them means stopping and asking (spec gate).

## Riskiest steps & de-risking

1. **T3 — the two-terminal narrative vs the one-shell harness.** If the verifiable sequence proves
   something weaker than the prose claims, the post asserts untested behavior. De-risk: write the
   single-shell sequence *first* and let the prose describe what it actually did; assert on **ids and
   `XINFO`**, never on timing or on how the split fell.
2. **The two-instance sample check.** Starting two workers concurrently from bash is where flake
   lives. De-risk: launch both with `SAMPLE_EXIT_AFTER_IDLE_POLLS=3` into separate log files, `wait`
   for both, then assert **Redis state** (union of `jobs.done.worker-*` = the seeded set, no `jobId`
   twice, `XPENDING` 0) rather than anything about interleaving.
3. **T7 — C#.** Already de-risked by finding the constraint *now* (Context7) instead of discovering it
   mid-implementation, and by writing the sample before the sentence that describes it.
4. **Budget.** 12 sections in 1600–1900 words with six samples to introduce. De-risk: T9's refactor
   pass is explicit, and `chk_wordcount` fails the build rather than letting it drift.

## How to run / what "done" looks like

```bash
./blog/work-queue-redis-streams/verify.sh                 # the whole acceptance suite
BLOG_WQ_PORT=6398 ./blog/work-queue-redis-streams/samples/setup.sh   # manual poke at one sample
luacheck lua/ --globals redis cjson cmsgpack bit
mvn clean test
```

Expect a run in the low minutes: `minIdle` is 5 s and each simulated job sleeps 2 s. Do **not**
"optimise" that by shrinking the values the post pins — `chk_coherence` would fail, and rightly.

**Done** = 13/13 in `verify.sh`, `luacheck` and `mvn clean test` unchanged, every acceptance box in
[`blog-workqueue-post.md`](blog-workqueue-post.md) tickable against real output, and both PRs proposed
(never pushed from the VM).
