"""
Work Queue on Redis Streams — one competing-consumer worker. Run it twice to see the split.
This sample assumes no prior Redis knowledge.

QUICKSTART — paste the indented lines into a terminal (needs Docker + uv):

    git clone https://github.com/dev-mansonthomas/RedisMessagingPatternsWithJedis.git
    cd RedisMessagingPatternsWithJedis
    export REDIS_URL="redis://localhost:$(./blog/work-queue-redis-streams/samples/setup.sh)"
    cd blog/work-queue-redis-streams/samples/python && uv run work_queue_worker.py worker-1

Then, in a SECOND terminal, the same command with a different consumer name — that is the whole
point of the pattern:

    export REDIS_URL="redis://localhost:6379"   # the port setup.sh printed
    cd RedisMessagingPatternsWithJedis/blog/work-queue-redis-streams/samples/python
    uv run work_queue_worker.py worker-2

setup.sh loads the Lua function, creates the group and queues 10 jobs; if nothing is listening on
localhost:6379 it starts a throwaway Redis 8.8 in Docker on a free port and prints that port.
Streams and consumer groups are explained from scratch in post #1:
https://github.com/dev-mansonthomas/RedisMessagingPatternsWithJedis/tree/blog-dlq-v1/blog/dlq-redis-streams

Two read paths, one handler:
  - hot path: XREADGROUP ... BLOCK 1000, because a blocking read is how you consume a queue;
  - every other iteration: FCALL read_claim_or_dlq, which reclaims entries orphaned by a dead
    worker and routes exhausted ones to the DLQ (a Lua function cannot block, hence two calls).
The function's last step is itself an XREADGROUP, so its reply carries NEW jobs too — feeding it
to a different code path would leak a job that is read and never acknowledged.

Env:
  REDIS_URL                      default redis://localhost:6379
  SAMPLE_EXIT_AFTER_IDLE_POLLS   unset = run forever (what a real worker does).
                                 Set to N to exit 0 after N polls that found nothing.

There is deliberately NO signal handler: killing this process with Ctrl-C while it holds a job is
the crash-recovery demo. The entry stays in the group's pending list and a peer reclaims it after
minIdle. Do not "fix" this by acknowledging on exit.
"""

import os
import sys
import time

import redis

STREAM = "jobs.imageProcessing.v1"
DLQ = "jobs.imageProcessing.v1:dlq"
GROUP = "jobs-group"

WORK_MS = 2000        # simulated work — the demo's SLOW pace, so the numbers match the article
MIN_IDLE_MS = 5000    # an entry idle this long is claimable by a peer; MUST outlast WORK_MS
COUNT = 1
MAX_DELIVER = 2


def blocking_read(r, consumer):
    """Hot path: block up to a second waiting for a job nobody has taken."""
    reply = r.xreadgroup(GROUP, consumer, {STREAM: ">"}, count=COUNT, block=1000)
    if not reply:
        return []
    entries = []
    for _stream, messages in reply:
        entries.extend(messages)  # (id, {field: value})
    return entries


def sweep(r, consumer):
    """
    Catch-up path: reclaim entries left pending by a dead worker and route exhausted ones to the
    DLQ. Returns the messages to process — they go through the same handler as the blocking read.
    """
    reply = r.fcall(
        "read_claim_or_dlq", 2, STREAM, DLQ,
        GROUP, consumer, str(MIN_IDLE_MS), str(COUNT), str(MAX_DELIVER),
    )
    if not reply:
        return []

    entries = []
    for pair in reply[0] or []:
        entry_id, flat = pair[0], pair[1] or []
        fields = dict(zip(flat[::2], flat[1::2]))
        entries.append((entry_id, fields))

    # reply[1] = [[original_id, dlq_id], ...] — jobs that burned their delivery budget.
    for routed in (reply[1] if len(reply) > 1 else []) or []:
        print(f"{consumer}: DLQ {routed[0]} -> {routed[1]}", flush=True)

    return entries


def handle(r, consumer, entry_id, fields):
    job_id = fields.get("jobId", "?")
    print(f"job {job_id} -> {consumer}", flush=True)
    time.sleep(WORK_MS / 1000)

    if fields.get("processingType", "OK") != "OK":
        # Failure: do NOT acknowledge. The delivery count climbs, and once it reaches
        # maxDeliver the next sweep routes the job to the DLQ.
        print(f"{consumer}: job {job_id} failed, not acknowledging", flush=True)
        return

    # The result first, then the ACK. Two commands, not one transaction: a crash between them
    # re-delivers the job and produces a duplicate result. At-least-once means whatever reads
    # the done stream must be idempotent.
    r.xadd(f"jobs.done.{consumer}", fields)
    r.xack(STREAM, GROUP, entry_id)
    print(f"{consumer}: job {job_id} done", flush=True)


def main():
    consumer = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else "worker-1"
    url = os.environ.get("REDIS_URL", "redis://localhost:6379")
    exit_after_idle = int(os.environ.get("SAMPLE_EXIT_AFTER_IDLE_POLLS", "0"))

    print(f"{consumer} connecting to {url}", flush=True)
    r = redis.Redis.from_url(url, decode_responses=True)

    iteration = 0
    idle_polls = 0
    while True:
        iteration += 1
        work = blocking_read(r, consumer)
        if iteration % 2 == 0:
            work += sweep(r, consumer)

        if not work:
            idle_polls += 1
            print(f"{consumer}: no new jobs", flush=True)
            if exit_after_idle and idle_polls >= exit_after_idle:
                print(f"{consumer}: idle {idle_polls} times, exiting", flush=True)
                return
            continue

        idle_polls = 0
        for entry_id, fields in work:
            handle(r, consumer, entry_id, fields)


if __name__ == "__main__":
    main()
