# Work queues on Redis Streams: one group, N workers

<!-- TODO(T9): section 1 — series intro (1 §) + where post #1 left off (2-3 sentences on the DLQ) -->

<!-- TODO(T9): section 2 — the problem: one consumer is a bottleneck; the guarantees, for architects -->

<!-- TODO(T9): section 3 — the topology + diagram -->

<!-- TODO(T9): section 4 — same function, more consumers (recall read_claim_or_dlq in <= 3 lines) -->

## Split the load across two workers

Everything below needs **Redis 8.4 or newer** — the function this post reuses reads with
`XREADGROUP … CLAIM`, which landed in 8.4. The walkthrough pins `redis:8.8-alpine`.

One script gets you a Redis with the function loaded and the consumer group created:

```bash
export REDIS_URL="redis://localhost:$(./blog/work-queue-redis-streams/samples/setup.sh)"
```

In real life you run one worker per terminal, and each one blocks on the stream waiting for work:

```bash
# terminal 1
redis-cli XREADGROUP GROUP jobs-group worker-1 COUNT 1 BLOCK 0 STREAMS jobs.imageProcessing.v1 '>'
# terminal 2
redis-cli XREADGROUP GROUP jobs-group worker-2 COUNT 1 BLOCK 0 STREAMS jobs.imageProcessing.v1 '>'
```

To keep every command on this page copy-pasteable into a single terminal, the rest of the
walkthrough uses `BLOCK 1000` — read for at most a second, then return — and plays both workers in
turn. Start from a clean slate and queue four jobs, keeping their ids:

<!-- verify:begin split -->
```bash
redis-cli DEL jobs.imageProcessing.v1 jobs.imageProcessing.v1:dlq jobs.done.worker-1 > /dev/null
redis-cli XGROUP CREATE jobs.imageProcessing.v1 jobs-group '$' MKSTREAM

JOB1=$(redis-cli   XADD jobs.imageProcessing.v1 '*' jobId JOB-0001 processingType OK    createdAt 2026-08-11T09:00:00Z)
POISON=$(redis-cli XADD jobs.imageProcessing.v1 '*' jobId JOB-0002 processingType Error createdAt 2026-08-11T09:00:01Z)
JOB3=$(redis-cli   XADD jobs.imageProcessing.v1 '*' jobId JOB-0003 processingType OK    createdAt 2026-08-11T09:00:02Z)
redis-cli          XADD jobs.imageProcessing.v1 '*' jobId JOB-0004 processingType OK    createdAt 2026-08-11T09:00:03Z
```

Now let each worker ask for one job. Note that **nothing had to be declared**: a consumer joins the
group the first time it reads — there is no `XGROUP CREATECONSUMER` step.

```bash
redis-cli XREADGROUP GROUP jobs-group worker-1 COUNT 1 BLOCK 1000 STREAMS jobs.imageProcessing.v1 '>'
# → JOB-0001

redis-cli XREADGROUP GROUP jobs-group worker-2 COUNT 1 BLOCK 1000 STREAMS jobs.imageProcessing.v1 '>'
# → JOB-0002
```

Two workers, two different jobs. The group's *pending entries list* — the PEL — records who holds
what:

```bash
redis-cli XPENDING jobs.imageProcessing.v1 jobs-group - + 10
# → one row per unacknowledged entry: id, consumer, idle ms, delivery count
#   …-0  worker-1  3  1
#   …-0  worker-2  1  1
```
<!-- verify:end split -->

That is the whole trick, and there is no configuration behind it: **one group, N consumers, and each
entry is handed to exactly one of them.** Distribution is not round-robin — whoever asks first gets
the next entry, so a faster worker legitimately takes more.

## Are my workers keeping up?

<!-- TODO(T9): prose — XLEN done streams is the toy instrument; this section is the real answer -->

<!-- verify:begin observe -->
```bash
# worker-1 finishes its job: copy the result, then acknowledge it
redis-cli XADD jobs.done.worker-1 '*' jobId JOB-0001 processingType OK > /dev/null
redis-cli XACK jobs.imageProcessing.v1 jobs-group "$JOB1"

redis-cli XINFO GROUPS jobs.imageProcessing.v1
# → consumers 2 · pending 1 · entries-read 2 · lag 2
```

`entries-read` and `lag` are the two numbers to watch: two entries have been delivered, and **two
are still waiting for a consumer**. `lag` answers "am I falling behind?" without scanning anything.
It can come back as `nil` after an `XTRIM`, `XDEL` or `XGROUP SETID`, when Redis can no longer count
exactly — treat that as "unknown", not zero.

```bash
redis-cli XPENDING jobs.imageProcessing.v1 jobs-group
# → 1 · lowest id · highest id · [[worker-2, 1]]

redis-cli XINFO CONSUMERS jobs.imageProcessing.v1 jobs-group
# → worker-1 pending 0 · worker-2 pending 1, with its idle time in ms
```
<!-- verify:end observe -->

<!-- TODO(T9): prose — pending vs entries-read vs lag: which question each one answers -->

## When a worker dies

<!-- TODO(T9): prose — the PEL is the safety net; name the XGROUP DELCONSUMER trap -->

`worker-2` is holding `JOB-0002` and never comes back — kill it with Ctrl-C, or just walk away. Its
entry stays in the PEL, owned by a consumer that no longer exists. After `minIdle` (5000 ms here),
any peer can claim it, and that is exactly what the function's claim step does:

<!-- verify:begin recovery -->
```bash
sleep 6   # one second past minIdle — 'idle >= minIdle' is evaluated to the millisecond

redis-cli FCALL read_claim_or_dlq 2 \
  jobs.imageProcessing.v1 jobs.imageProcessing.v1:dlq \
  jobs-group worker-1 5000 1 2
# → JOB-0002 comes back, now owned by worker-1

redis-cli XPENDING jobs.imageProcessing.v1 jobs-group - + 10
# → …-0  worker-1  7  2      ← same entry, delivery count is now 2
```

The reclaim cost one delivery. `JOB-0002` is marked `Error`, so `worker-1` fails too and does not
acknowledge it. Its delivery count has reached the budget (`maxDeliver` = 2), so the **next** poll
sweeps it into the dead-letter stream:

```bash
sleep 6

redis-cli FCALL read_claim_or_dlq 2 \
  jobs.imageProcessing.v1 jobs.imageProcessing.v1:dlq \
  jobs-group worker-1 5000 1 2
# → two things at once: JOB-0003 to process, and the pair [original id, dlq id] for JOB-0002

redis-cli XRANGE jobs.imageProcessing.v1:dlq - +
# → JOB-0002, with its fields intact

# the same call handed worker-1 the next job — finish it
redis-cli XACK jobs.imageProcessing.v1 jobs-group "$JOB3"

redis-cli XPENDING jobs.imageProcessing.v1 jobs-group
# → 0 pending: nothing is stuck

redis-cli XINFO CONSUMERS jobs.imageProcessing.v1 jobs-group
# → worker-2 is STILL listed, with pending 0
```
<!-- verify:end recovery -->

That last line is the point of this section. `worker-2` is gone, but its consumer record stays in the
group, and **that is what you want**: deleting it with `XGROUP DELCONSUMER` while it still held
`JOB-0002` would have removed the entry from the PEL along with it, and the job would simply have
vanished. Stop the loop, leave the consumer alone, and let the claim step recover the work.

<!-- TODO(T9): section 8 — poll vs BLOCK, and the production split (Lua cannot block) -->

<!-- TODO(T9): section 9 — the minIdle rule: minIdle must outlast the work, or a free worker
     double-processes a job its busy peer is still running. 2000 ms work / 5000 ms minIdle. -->

<!-- TODO(T9): section 10 — other levers, one sentence each: COUNT batching, MAXLEN/XTRIM -->

<!-- TODO(T9): section 11 — run a real worker in 6 languages: links + 1 inline Jedis excerpt -->

<!-- forbidden-exempt:begin -->
<!-- TODO(T9): section 12 — see it live & what's next -->
<!-- forbidden-exempt:end -->
