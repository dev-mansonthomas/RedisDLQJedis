# Blog post #2 — Work Queue (Competing Consumers) with Redis Streams

> Slice B of [`docs/product/brief-blog-workqueue-post.md`](../product/brief-blog-workqueue-post.md).
> Series conventions: [`brief-blog-series.md`](../product/brief-blog-series.md) — unchanged.
> Branch: `blog/work-queue-post`. Written for agents: implement exactly this.
> Publication tag (created by the author, on the host, at publish time): **`blog-workqueue-v1`**
> — see [`blog/PUBLISHING.md`](../../blog/PUBLISHING.md). The pinned permalinks **404 until that tag
> is pushed**; that is expected and the harness only checks that each linked path exists locally.
> Slice A (the demo's runtime-adjustable worker pool) is **delivered** — see
> [`work-queue-dynamic-workers.md`](work-queue-dynamic-workers.md).

## Purpose

Produce the second post of the "Redis Messaging Patterns" series for the official Redis blog
(English): the **Work Queue / Competing Consumers pattern on Redis Streams** — one stream, **one**
consumer group, N consumers, each job delivered to exactly one of them. Post #1 showed that a poison
message must not block a queue; it said nothing about **volume**. This post's single lever is
**adding consumers**, and its second half is about *observing* the result: `XINFO GROUPS` (`lag`,
`entries-read`), `XPENDING`, `XINFO CONSUMERS`. It reuses the **same Redis Function as post #1**
(`read_claim_or_dlq`, unchanged) so there is no new Redis primitive to learn — all the new content is
topology, observability and sizing. The reader must be able to reproduce everything **CLI-first**
(`redis-cli`) and then run a real worker in **6 languages** from samples versioned in this repo.

## Deliverables (file tree)

```
blog/work-queue-redis-streams/
├── index.md                       # the post (English, 1600–1900 words of prose)
├── verify.sh                      # acceptance harness (same shape as post #1's)
├── img/
│   ├── work-queue-flow.png        # exported logical diagram (referenced by index.md, alt text required)
│   └── work-queue-flow.excalidraw # editable source
└── samples/
    ├── setup.sh                   # self-starting Redis + FUNCTION LOAD REPLACE + XGROUP CREATE + seed
    ├── java/                      # pom.xml + src/main/java/WorkQueueWorker.java     (Jedis)
    ├── python/                    # pyproject.toml (uv) + work_queue_worker.py        (redis-py)
    ├── node/                      # package.json + work-queue-worker.mjs              (node-redis)
    ├── go/                        # go.mod + main.go                                  (go-redis v9)
    ├── csharp/                    # WorkQueueWorker.csproj + Program.cs               (NRedisStack)
    └── rust/                      # Cargo.toml + src/main.rs                          (redis crate)
```

Nothing outside that tree changes, **except**: `blog/PUBLISHING.md` gains `blog-workqueue-v1` in its
path list, and `docs/TODO.md` / `CLAUDE.md` record whatever the coherence audit below turns up.
The French version is slice C (`index.fr.md`) — not this spec.

## User stories / acceptance criteria

- As a backend dev who read post #1, I can add a second consumer to an existing group and see the
  jobs split between the two, so that I believe scaling out is free.
- As the same dev, I leave knowing that **`XREADGROUP … BLOCK` is the production read mode**, and why
  this repo's demo polls instead.
- As a messaging architect, I find the guarantees stated explicitly and early: at-least-once, **one
  job processed by one worker**, no job lost when a worker dies, bounded retry then DLQ.
- As an operator, I can answer "are my workers keeping up?" with `XINFO GROUPS` (`lag`,
  `entries-read`) and `XPENDING` rather than by guessing.
- As a polyglot dev, I can run the worker of my language twice in two terminals with one documented
  command each and watch the distribution happen.

Testable criteria — each is a named check in `blog/work-queue-redis-streams/verify.sh`.
**All 17 checks green on 2026-08-11** (`./blog/work-queue-redis-streams/verify.sh` → `17 passed, 0
failed`), alongside `luacheck` 0 errors and `mvn clean test` 93/93, 0 skipped — the pair that proves
the post required no demo or Lua change.

- [x] `chk_shellcheck` — `shellcheck` on `samples/setup.sh` and on `verify.sh` → 0 findings.
- [x] `chk_setup` — on a fresh `redis:8.8-alpine`, `samples/setup.sh` run **twice** exits 0 both
      times (idempotent), and afterwards `FUNCTION LIST LIBRARYNAME stream_utils` is non-empty and
      `XINFO GROUPS jobs.imageProcessing.v1` lists `jobs-group`.
- [x] `chk_walkthrough` — every `` ```bash `` block between `<!-- verify:begin -->` /
      `<!-- verify:end -->` markers in `index.md`, replayed **in document order, verbatim, in one
      shell** (with `redis-cli` rewritten to the harness port), exits 0 and leaves the end state the
      post claims: `XPENDING jobs.imageProcessing.v1 jobs-group` summary count is `0` and
      `XLEN jobs.imageProcessing.v1:dlq` is `1`.
- [x] `chk_distribution` — inside that replay, two different consumer names reading the same group
      receive **disjoint** entry ids, and the union equals the produced set (no entry delivered
      twice, none skipped). Asserted on ids, never on how the split happened to fall.
- [x] `chk_recovery` — inside that replay: an entry read as `worker-2` and left un-ACKed is, after
      `minIdle` has elapsed, returned by a `FCALL read_claim_or_dlq` issued as `worker-1`, and
      `XINFO CONSUMERS jobs.imageProcessing.v1 jobs-group` **still lists `worker-2`** (proof the post
      never tells the reader to `XGROUP DELCONSUMER`).
- [x] `chk_sample_<lang>` for **java, python, node, go, csharp, rust** — with
      `SAMPLE_EXIT_AFTER_IDLE_POLLS=3` set, the documented one-liner exits **0** on its own, and its
      stdout shows (a) at least one `job … done` line naming the consumer it was passed and (b) a
      `no new jobs` line before it exits. Then: two instances of the **same** sample started with
      different consumer names against a 10-job backlog together drain it, each printing ≥ 1 job,
      with `XPENDING` back to 0 and **no `jobId` completed twice** (union of `jobs.done.worker-*`).
- [x] `chk_wordcount` — prose word count of `index.md` (fenced code blocks and URLs excluded) is
      **1600–1900**.
- [x] `chk_links` — every `github.com/dev-mansonthomas/RedisMessagingPatternsWithJedis/(blob|tree)/…`
      URL in `index.md` is pinned on **`blog-workqueue-v1`** and its path exists in the working tree.
      **Amended 2026-08-11**: links *into post #1* are pinned on **its** already-published tag
      (`blog-dlq-v1`), so the check accepts either tag and rejects anything on a branch. The first
      version of the check failed the post's own back-reference, which was a harness bug, not a
      content error.
- [x] `chk_forbidden` — `websocket|sockjs|angular|spring` appears nowhere in the prose (fenced blocks
      stripped, and the closing "see it live" section wrapped in
      `<!-- forbidden-exempt:begin/end -->` as post #1 does).
- [x] `chk_img` — `img/work-queue-flow.png` exists and `index.md` references it as
      `![<alt text>](img/work-queue-flow.png)` with non-empty alt text.
- [x] `chk_coherence` — the timing numbers the post pins are the demo's own: the post's prose
      contains `2000` (work) and `5000` (`minIdle`) **and** `WorkQueueService.java` still declares
      `SLOW("Slow", 2000, 5000, …)`. Fails loudly if either side moves — this is the drift guard the
      series brief asks for.
- [x] `chk_no_xautoclaim` — neither `index.md` nor any sample mentions `XAUTOCLAIM` or `XNACK`
      (out of scope by the brief: they belong to other patterns / post #1).
- [x] `mvn clean test` still green and `luacheck lua/ --globals redis cjson cmsgpack bit` still 0
      errors — proves the post required no demo or Lua change.

## Inputs & outputs

### The function being reused (read-only — no Lua change in this slice)

`lua/stream_utils.lua` → `read_claim_or_dlq`, exactly as post #1 documented it:

```
FCALL read_claim_or_dlq 2 <stream> <dlq> <group> <consumer> <minIdleMs> <count> <maxDeliver>
Returns: [ messages_to_process = [[id, [f1,v1,...]], ...],
           dlq_ids            = [[original_id, dlq_id], ...] ]
```

Steps: (1) `XPENDING … IDLE minIdle` for entries at `deliveries >= maxDeliver`, (2) `XCLAIM` → `XADD`
to the DLQ → `XACK`, (3) `XREADGROUP … CLAIM minIdle … >`, (4) return both arrays. The post
**recalls** these in ≤ 3 lines and links post #1 for the detail — it must not re-explain the claim
mechanics (hard budget rule from the brief).

### Keys, names and numbers — identical in post, `setup.sh`, samples and demo

| Thing | Value | Source of truth |
|---|---|---|
| Job stream | `jobs.imageProcessing.v1` | `WorkQueueService.JOB_STREAM` |
| Consumer group | `jobs-group` | `WorkQueueService.JOB_GROUP` |
| DLQ | `jobs.imageProcessing.v1:dlq` | `WorkQueueService.JOB_DLQ` |
| Done stream (per worker) | `jobs.done.<consumer>` → `jobs.done.worker-N` | `WorkQueueService.JOB_DONE_PREFIX` |
| Consumer name | `worker-1`, `worker-2`, … | `WorkQueueService.consumerName(int)` |
| Job fields | `jobId`, `processingType` (`OK`\|`Error`), `createdAt` | `WorkQueueService.produceJob` |
| `count` | `1` | demo |
| `maxDeliver` | `2` | `WorkQueueService.MAX_DELIVERIES` |
| **Simulated work** | **2000 ms** | `DemoMode.SLOW.workMs()` |
| **`minIdle`** | **5000 ms** | `DemoMode.SLOW.minIdleMs()` |

**Decision (2026-08-11, supersedes the brief's `minIdle=100`).** The brief pinned `minIdle=100 ms`
"same as the demo"; slice A deleted that value. The post pins the demo's **`SLOW` preset** — work
2000 ms, `minIdle` 5000 ms — because it is the only window in which a human can hit Ctrl-C while a
job is in flight and then watch a peer reclaim it. It also lets the post state the invariant slice A
now enforces in code: **`minIdle` must outlast the processing time** (rule of thumb `minIdle >= 2 ×
work`), or a *free* consumer claims a job its busy peer is still running and the job silently runs
twice. That sentence is the post's one hard-won correctness lesson and is **required** (it is framed
as correctness, not as a measured performance claim — the series' no-benchmark rule stands).

### `samples/setup.sh` contract

Same self-starting shape as post #1's (that convention shipped in PR #18), with the work-queue names:

- Env: `BLOG_WQ_PORT` (default `6379`), `SEED_JOBS` (default `10`).
- If something answers `PING` on that port, use it; otherwise start a throwaway
  `redis:8.8-alpine` named **`blog-workqueue-redis`** on a Docker-chosen free port.
- `redis-cli -x FUNCTION LOAD REPLACE < lua/stream_utils.lua` → must reply `stream_utils`.
- `XGROUP CREATE jobs.imageProcessing.v1 jobs-group $ MKSTREAM`, tolerating `BUSYGROUP`.
- Seed `SEED_JOBS` jobs (`jobId=JOB-0001…`, every 10th `processingType=Error`, the rest `OK`) so a
  worker started right after has a visible backlog. Seeding is **not** idempotent by nature → it
  seeds only when `XLEN` is 0, so a re-run does not double the backlog.
- **stdout carries the port and nothing else** (all logs to stderr), so
  `export REDIS_URL="redis://localhost:$(./blog/work-queue-redis-streams/samples/setup.sh)"` works.
- Idempotent, `set -euo pipefail`, run from the repo root, `shellcheck`-clean.

### Samples contract (all 6 identical in behavior)

A **worker**, not a one-shot script — this is the shape post #2 teaches:

**Amendment (2026-08-11) — five block, C# polls.** Verified via Context7: StackExchange.Redis (which
NRedisStack sits on) ships **no blocking commands at all** — *"Due to its multiplexing nature,
StackExchange.Redis does not offer blocking pop commands … as they could stall the entire
multiplexer"* — and `StreamReadGroup` exposes no `BLOCK`. So the C# sample **polls**:
`StreamReadGroup(count: 1)` plus a 1 s sleep when the read is empty, with a header comment naming the
reason. Its sweep still goes through `db.Execute("FCALL", …)` as post #1's C# sample does. The post
gains **one sentence** on it, and `chk_sample_csharp` must not require a blocking read. Rejected:
forcing `db.Execute("XREADGROUP", …, "BLOCK", …)`, which works around a deliberate design choice and
risks `SyncTimeout` flakiness. The deviation is useful content — it is a constraint readers hit, and it
reinforces the post's own "why the demo polls" paragraph.

- **Args:** `$1` = consumer name, default `worker-1`.
- **Env:** `REDIS_URL` (default `redis://localhost:6379`), `SAMPLE_EXIT_AFTER_IDLE_POLLS`
  (**unset = run forever**, the reader's case; set to `N` = exit 0 after N consecutive polls that
  returned nothing, which is how `verify.sh` gets a deterministic exit).
- **Loop:**
  1. `XREADGROUP GROUP jobs-group <consumer> COUNT 1 BLOCK 1000 STREAMS jobs.imageProcessing.v1 >`
     — the hot path.
  2. Every ~2 s (i.e. every other iteration, tracked with a counter — **no wall-clock timers**):
     `FCALL read_claim_or_dlq 2 jobs.imageProcessing.v1 jobs.imageProcessing.v1:dlq jobs-group
     <consumer> 5000 1 2` — the catch-up sweep.
  3. **Both sources feed the same handler.** This is the one bug that would make the samples wrong:
     `read_claim_or_dlq` step 3 is itself an `XREADGROUP >`, so the sweep returns *new* messages too.
     A sample that treats the `FCALL` reply as "only reclaimed work" leaks a read-but-never-ACKed
     job. Log the `dlq_ids` array when non-empty.
- **Handler:** print `job <jobId> -> <consumer>`; sleep **2000 ms** (simulated work); then
  - `processingType = OK` → `XADD jobs.done.<consumer> * <the job's fields>` then `XACK`. Comment
    that the two are not atomic → at-least-once → consumers must be idempotent.
  - `processingType = Error` → **no `XACK`**, print why. This is what drives the retry then the DLQ
    route on the following sweeps, exactly like the demo.
- **No signal handler.** Ctrl-C must kill the process mid-job with the entry still in the PEL — that
  *is* the crash-recovery demo. Say so in a comment so nobody "fixes" it later.
- **~70–90 lines**, no framework, no threads/goroutines/tasks: mono-thread on purpose, so the six
  read identically and two terminals are the unit of scaling.
- **Header:** the post #1 QUICKSTART block (clone → `setup.sh` into `REDIS_URL` → the run one-liner),
  a second one-liner showing the **second terminal** with `worker-2`, and a one-line pointer to post
  #1 for the streams/consumer-group primer (do not repeat that primer six times).

Print with plain `stdout` only; no colours, no spinners (the reader may pipe it).

### `index.md` section plan (order is normative)

1. **Series intro** (1 §) + where post #1 left off: DLQ recap in **2–3 sentences max** + link.
2. **The problem** — one consumer is a bottleneck; the guarantees of competing consumers, as an
   architect-facing list (at-least-once · one job → one worker · no loss when a worker dies ·
   bounded retry → DLQ).
3. **The topology** — the diagram (producer → stream → **1 group** → N workers → per-worker done
   streams, dashed DLQ arrow back to post #1) + narrative. Emphasise: *one* group, not N; adding a
   consumer needs no `XGROUP CREATECONSUMER` — the first read registers it.
4. **Same function, more consumers** — `read_claim_or_dlq` recalled in ≤ 3 lines + link.
5. **Split the load in two terminals** — CLI walkthrough part 1. `XLEN jobs.done.worker-N` as the
   visual instrument, explicitly labelled *a measuring device for this walkthrough, not a production
   practice*.
6. **Are my workers keeping up?** — `XINFO GROUPS` (`lag`, `entries-read`), `XPENDING` summary +
   per-consumer form, `XINFO CONSUMERS` (`pending`, `idle`). This is the post's real answer to
   observability; section 5 is the toy one.
7. **When a worker dies** — CLI walkthrough part 2: un-ACKed entry → wait `minIdle` → a peer's
   `FCALL` reclaims it. Names the **`XGROUP DELCONSUMER` trap** explicitly: never delete a consumer
   that still has PEL entries, they leave the PEL with it and the jobs are lost; stop the loop and
   let the claim path recover. DLQ in **2–3 sentences** + link post #1.
8. **Poll vs `BLOCK`** — `XREADGROUP … BLOCK` is the production read mode. The **production split**:
   a Lua function **cannot block**, so the hot path is `XREADGROUP … BLOCK` and the catch-up (claim
   idle entries + route to the DLQ) is a periodic `FCALL` — which is exactly the shape of the
   samples, and of pattern #12 in this repo (worker + separate sweeper). The demo's 500 ms poll is a
   visualisation choice, stated as such.
9. **The `minIdle` rule** — one short paragraph: `minIdle` must outlast the processing time, or a
   free consumer double-processes a job its peer is still working on; no error, empty PEL, empty DLQ.
   Rule of thumb `minIdle >= 2 × work`; the demo enforces it in code.
10. **Other levers, one sentence each** — batching (`COUNT` > 1 + grouped `XACK`) and retention
    (`MAXLEN` / `XTRIM`). Explicitly *not* developed.
11. **Run a real worker in 6 languages** — the six pinned links + **exactly one** inline real-code
    excerpt (5–15 lines): the Jedis `fcall` call from `WorkQueueService.processNextJob`, followed by
    its pinned permalink. `removeWorker`'s never-`DELCONSUMER` rule is referenced by permalink, not
    inlined.
12. **See it live & what's next** — repo, `./launch-docker.sh --build`, the `/work-queue` page (add /
    remove / kill a worker, `Slow` mode), series teaser. Wrapped in the forbidden-exempt markers.

## Behavior & edge cases

The post and its walkthrough must get these right — they are where readers go wrong:

- **Two terminals cannot be replayed by the harness.** The narrative shows two terminals; the
  **verify-marked** blocks must be an equivalent *single-shell* sequence — read as `worker-1`, then
  as `worker-2`, and assert the ids are disjoint. Keep the two-terminal blocks **outside** the
  `verify:begin/end` markers (they are still shown to the reader), and make sure the single-shell
  sequence proves the same claim. Nothing the post asserts may be unverifiable.
- **`BLOCK` inside a verify-marked block must not hang the harness.** Use `BLOCK 1000` (never
  `BLOCK 0`) in any block the harness replays.
- **Distribution is not round-robin and must never be presented as such.** `XREADGROUP` hands each
  new entry to whoever asks first; a fast consumer legitimately takes more. Assert *disjointness*,
  never a split ratio — and word the prose the same way.
- **A never-delivered entry cannot reach the DLQ** (post #1's rule, still true): DLQ routing reads
  `XPENDING`, so an entry must have been read at least once, be idle ≥ `minIdle`, and have
  `deliveries >= maxDeliver`. With `maxDeliver = 2`: delivered twice, and the *next* sweep routes it.
  Phrase it as "delivered `maxDeliver` times, then the next poll sweeps it" — never "after N
  failures it goes to the DLQ".
- **The walkthrough's waits are real.** `minIdle = 5000` means the recovery step needs a
  `sleep 5` (or an explicit `IDLE` note) before the reclaiming `FCALL`; the harness must budget for
  it, and the post must show the wait rather than pretending it is instant.
- **`lag` can be `NULL`.** After `XTRIM`/`XDEL` or an `XGROUP SETID`, Redis reports `lag` as nil
  because it can no longer count exactly; the observability section must say so instead of promising
  a number always exists.
- **`entries-read` is per group, `pending` is per consumer.** Don't mix them; `XPENDING` with no
  filter returns the *summary* form (count, min id, max id, per-consumer list), which is the one the
  post shows first.
- **Both `FCALL` result arrays can be empty** — every sample prints "no new jobs" gracefully, and
  that line is what `SAMPLE_EXIT_AFTER_IDLE_POLLS` counts.
- **RESP2 vs RESP3 reply shapes** differ across the 6 clients (nested arrays vs maps/typed values);
  each sample parses defensively, and each client's `FCALL`/`XREADGROUP` API is verified against
  current docs via **Context7** at implementation time — never from training memory.
- **Redis version:** the post requires **8.4+** (`XREADGROUP … CLAIM`, used by `read_claim_or_dlq`)
  — *not* 8.8, since this post uses no `XNACK` — stated before the first command, while the
  walkthrough still pins `redis:8.8-alpine` (project baseline).
- **`setup.sh` re-run must not double the backlog** (seed only when `XLEN` is 0), or the sample check
  counts jobs it did not produce.
- **Permalinks 404 until the tag is pushed** — acceptance checks local path existence only; the
  author pushes `blog-workqueue-v1` from the host.

### Coherence audit (blocking, before writing prose)

Slice A already fixed the drift it found (spec `mygroup` → `jobs-group`, the mermaid diagram, the
page's hard-coded stream names). What remains to be checked and reported **before** the prose is
written:

1. `README.md` — its work-queue mentions still describe a fixed 4-worker pool / old names?
2. `docs/specs/work-queue.md` ↔ `WorkQueueService` — re-check after slice A's merge (numbers, the
   three `/workers` endpoints, demo modes).
3. `lua/stream_utils.lua` ↔ what the post says `read_claim_or_dlq` does (must be identical to post
   #1's description — if the two posts describe it differently, one of them is wrong).
4. The `/work-queue` page's info text ↔ the post's numbers (the `chk_coherence` box automates the
   `2000`/`5000` half of this).
5. **`docs/diagrams/work-queue.md`** — added 2026-08-11: this file was missing from the list above and
   turned out to be the worst offender. `README.md` links to it.

Report every discrepancy with a proposed fix and **wait for the author's explicit validation before
changing any demo code or existing doc** — the post adapts to the code, not the reverse.

### Audit result (run 2026-08-11 — docs only, no demo code touched)

| # | Surface | Verdict |
|---|---|---|
| 1 | `README.md:300` | ❌ **stale** — "One consumer group, 4 Virtual-Thread workers". → rewritten to 1–8 adjustable at runtime + the kill demo. |
| 2 | `docs/specs/work-queue.md` | ✅ clean — slice A rewrote it from the code (`jobs-group`, the `SLOW` 2000/5000 and `FAST` 50/500 presets, the three `/workers` endpoints, no "Inferred" left). |
| 3 | `lua/stream_utils.lua` ↔ post #1 | ✅ clean — post #1's pseudo-code (`index.md` l. 61-67) mirrors the Lua 1:1. Post #2 recalls **that exact wording** in ≤ 3 lines rather than paraphrasing it. |
| 4 | `/work-queue` page text | ✅ better than clean — the page *interpolates* the backend's numbers (`{{ opt.workMs }}`, `{{ demo.minIdleMs }}`), so it is structurally incapable of drifting. Only the post can drift, which is what `chk_coherence` guards. |
| 5 | `docs/diagrams/work-queue.md` | ❌ **wrong on five axes** — `jobs.workqueue.v1`, `job-queue-group`, `workerN.done`, a fixed 3 workers (the doc twin of slice A's finding #3, never fixed), plus a **factually false guarantee**: it advertised "Exactly-Once Delivery", which consumer groups do not provide and which this post explicitly contradicts. It also showed `XACK` *before* the done-stream `XADD`, the reverse of the code. → rewritten from the code, with at-least-once, the `minIdle` rule and the `DELCONSUMER` trap stated. |

No demo-code change was needed, so the validation gate was not triggered. One **opportunity** found
while checking versions, recorded in `docs/TODO.md` and deliberately **not** acted on here: **Jedis
8.0.0 is now GA** and ships a typed `xnack(String, String, XNackMode, StreamEntryID…)`, which unblocks
the `DLQMessagingService.XnackCommand` raw-`sendCommand` workaround (ADR-0011). That is a demo change,
out of this post's scope, and the author's call.

## Out of scope

- **Slice C**, the French `index.fr.md` (comes after the English version is validated).
- `XAUTOCLAIM`, partitioning/sharding, priority queues (`chk_no_xautoclaim` enforces the first).
- `XNACK` and any re-explanation of the claim/delivery-count mechanics — post #1 owns those.
- **Measured numbers, micro-benchmarks, any performance promise** (series rule). "Adding consumers
  increases throughput" is stated as a property of the topology, never quantified.
- Batching and retention beyond one sentence each; production hardening (HA, cluster, ACL, TLS).
- Demo code changes (audit-validated fixes excepted), CMS submission mechanics, front-matter.
- Any mention of WebSocket / Angular / SockJS / Spring in the prose (`chk_forbidden`).
- Multi-threaded workers: the samples are deliberately mono-thread; two processes are the unit.

## Test plan

Everything lives in `blog/work-queue-redis-streams/verify.sh`, modelled on post #1's harness (same
`ok`/`ko`/`verdict` helpers, throwaway container `blog-workqueue-verify` on `${BLOG_WQ_PORT:-6398}`,
`trap cleanup EXIT`, final `N passed, M failed` line and non-zero exit on any failure). Checks, in
run order:

1. `chk_shellcheck` — `setup.sh` + `verify.sh`.
2. `chk_setup` — run `setup.sh` twice; assert library + group; assert `XLEN` did **not** double.
3. `chk_walkthrough` — replay the verify-marked blocks in one shell with `redis-cli` rewritten to the
   harness port; assert the end state (`XPENDING` summary 0, DLQ `XLEN` 1).
4. `chk_distribution` — disjoint ids across two consumer names, union = produced set.
5. `chk_recovery` — un-ACKed entry reclaimed by a peer after `minIdle`; `worker-2` still listed by
   `XINFO CONSUMERS`.
6. `chk_sample_<lang>` × 6 — `SAMPLE_EXIT_AFTER_IDLE_POLLS=3`, the documented one-liner, exit 0,
   required output lines; then the **two-instance** drain (different consumer names, 10-job backlog,
   started concurrently): `XPENDING` → 0, each printed ≥ 1 job, and **no `jobId` appears twice**
   across `jobs.done.worker-*`. A missing toolchain is a **`ko`** naming the tool (never a silent
   skip — a skipped sample is not a pass).
7. `chk_wordcount` (1600–1900), `chk_links` (`blog-workqueue-v1`), `chk_forbidden`, `chk_img`,
   `chk_coherence`, `chk_no_xautoclaim`.
8. Outside `verify.sh`: `mvn clean test` green and `luacheck` unchanged (proves the post touched no
   demo code), plus a visual markdown render to confirm the diagram displays with its alt text.

Toolchains needed: JDK 21 + Maven, Node 24, `uv`, Go, .NET SDK, Rust, `shellcheck`, `redis-cli`,
Docker — all present in this VM per `CLAUDE.md`. Budget note: the harness sleeps for `minIdle`
(5 s) at least once and each sample sleeps 2 s per job, so expect a run in the low minutes; do not
"optimise" that by shrinking `minIdle` below the value the post pins.

## Dependencies & risks

- **No new project dependency** — the samples are standalone mini-projects; the demo keeps Jedis and
  nothing else. Client versions **verified against the registries 2026-08-11** (authoritative metadata,
  not training memory), and post #1's pins are stale in three places:

  | Sample | Post #1 pins | Latest stable | Post #2 uses |
  |---|---|---|---|
  | java (Jedis) | 7.5.3 | **8.0.0** (GA) | **8.0.0** — `count/block/claim` + `fcall` are byte-identical to 7.5.3 (checked with `javap` on both jars), so nothing in the prose changes |
  | python (redis-py) | `redis>=8` | 8.1.0 | `redis>=8.1` (floating pin already resolved to it) |
  | node (node-redis) | `^6.1.0` | 6.2.1 | `^6.2.1` |
  | go (go-redis) | v9.21.0 | v9.22.0 | v9.22.0 |
  | csharp (NRedisStack) | 0.13.1 | **1.7.3** (SE.Redis 3.1.13) | **1.7.3** — a major jump; API re-verified by running it |
  | rust (`redis`) | 0.32 | **1.5.0** | **1.5.0** — crosses 1.0, so `StreamReadOptions` is re-verified by running it |

  Post #1's samples are left alone (they pin their own versions and still run); the drift is recorded in
  `docs/TODO.md` as a separate chore.
- **Riskiest #1 — the two read paths in the samples.** `read_claim_or_dlq` returns new messages as
  well as reclaimed ones, so a sample that routes only the `XREADGROUP` result to its handler leaks a
  job that is read and never ACKed. Mitigation: the single-handler rule above, plus the
  two-instance `chk_sample` assertion that `XPENDING` ends at 0 and no `jobId` completes twice.
- **Riskiest #2 — overlap with post #1.** Same Lua, same DLQ. If the prose re-explains the claim, the
  post loses its reason to exist. Mitigation: the 2–3-sentence DLQ budget, systematic linking, and
  the word-count gate leaving no room to drift.
- **Riskiest #3 — the harness and the narrative disagreeing.** The two-terminal story is the point of
  the post but is not replayable in one shell; the single-shell equivalent must prove the same claim
  or the post asserts something untested. Mitigation: `chk_distribution` / `chk_recovery` assert on
  ids and `XINFO`, and the review step re-reads section 5/7 against those two checks.
- **Timing drift** between post and demo: guarded by `chk_coherence` (the `2000`/`5000` pair must
  exist on both sides).
- **Slice A must be merged first** — the post links `WorkQueueService` line ranges and claims the
  page can add/remove/kill workers. If slice A's PR is still open, the permalinks will point at
  paths that exist locally but not on `main` at tag time.

## Next step

Run `/plan-feature blog-workqueue-post` to break this into TDD-ordered steps (audit → `setup.sh` →
verify-marked walkthrough → the 6 samples → diagram → prose → `verify.sh` green).
