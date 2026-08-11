/*
Work Queue on Redis Streams — one competing-consumer worker. Run it twice to see the split.
This sample assumes no prior Redis knowledge.

QUICKSTART — paste the indented lines into a terminal (needs Docker + Node.js):

    git clone https://github.com/dev-mansonthomas/RedisMessagingPatternsWithJedis.git
    cd RedisMessagingPatternsWithJedis
    export REDIS_URL="redis://localhost:$(./blog/work-queue-redis-streams/samples/setup.sh)"
    cd blog/work-queue-redis-streams/samples/node && npm install && node work-queue-worker.mjs worker-1

Then, in a SECOND terminal, the same command with a different consumer name — that is the whole
point of the pattern:

    export REDIS_URL="redis://localhost:6379"   # the port setup.sh printed
    cd RedisMessagingPatternsWithJedis/blog/work-queue-redis-streams/samples/node
    node work-queue-worker.mjs worker-2

setup.sh loads the Lua function, creates the group and queues 10 jobs; if nothing is listening on
localhost:6379 it starts a throwaway Redis 8.8 in Docker on a free port and prints that port.
Streams and consumer groups are explained from scratch in post #1:
https://github.com/dev-mansonthomas/RedisMessagingPatternsWithJedis/tree/blog-dlq-v1/blog/dlq-redis-streams

Two read paths, one handler:
  - hot path: XREADGROUP … BLOCK 1000, because a blocking read is how you consume a queue;
  - every other iteration: FCALL read_claim_or_dlq, which reclaims entries orphaned by a dead
    worker and routes exhausted ones to the DLQ (a Lua function cannot block, hence two calls).
The function's last step is itself an XREADGROUP, so its reply carries NEW jobs too — feeding it to
a different code path would leak a job that is read and never acknowledged.

Env:
  REDIS_URL                      default redis://localhost:6379
  SAMPLE_EXIT_AFTER_IDLE_POLLS   unset = run forever (what a real worker does).
                                 Set to N to exit 0 after N polls that found nothing.

There is deliberately NO SIGINT handler: killing this process with Ctrl-C while it holds a job is
the crash-recovery demo. The entry stays in the group's pending list and a peer reclaims it after
minIdle. Do not "fix" this by acknowledging on exit.
*/

import { createClient } from 'redis';

const STREAM = 'jobs.imageProcessing.v1';
const DLQ = 'jobs.imageProcessing.v1:dlq';
const GROUP = 'jobs-group';

const WORK_MS = 2000;      // simulated work — the demo's SLOW pace, matching the article
const MIN_IDLE_MS = 5000;  // idle this long and a peer may claim it; MUST outlast WORK_MS
const COUNT = 1;
const MAX_DELIVER = 2;

const consumer = process.argv[2] || 'worker-1';
const url = process.env.REDIS_URL || 'redis://localhost:6379';
const exitAfterIdle = Number(process.env.SAMPLE_EXIT_AFTER_IDLE_POLLS || 0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const asString = (v) => (v instanceof Buffer ? v.toString() : String(v));

/** Hot path: block up to a second waiting for a job nobody has taken. */
async function blockingRead(client) {
  const reply = await client.xReadGroup(
    GROUP, consumer,
    { key: STREAM, id: '>' },
    { COUNT, BLOCK: 1000 },
  );
  if (!reply) return [];
  return reply.flatMap((perStream) =>
    perStream.messages.map((m) => ({ id: m.id, fields: m.message })));
}

/**
 * Catch-up path: reclaim entries orphaned by a dead worker and route exhausted ones to the DLQ.
 * Returns the messages to process, for the same handler as the blocking read.
 */
async function sweep(client) {
  const reply = await client.fCall('read_claim_or_dlq', {
    keys: [STREAM, DLQ],
    arguments: [GROUP, consumer, String(MIN_IDLE_MS), String(COUNT), String(MAX_DELIVER)],
  });
  if (!Array.isArray(reply) || reply.length === 0) return [];

  const entries = (reply[0] || []).map(([id, flat]) => {
    const fields = {};
    const pairs = flat || [];
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      fields[asString(pairs[i])] = asString(pairs[i + 1]);
    }
    return { id: asString(id), fields };
  });

  // reply[1] = [[originalId, dlqId], …] — jobs that burned their delivery budget.
  for (const routed of reply[1] || []) {
    console.log(`${consumer}: DLQ ${asString(routed[0])} -> ${asString(routed[1])}`);
  }
  return entries;
}

async function handle(client, { id, fields }) {
  const jobId = fields.jobId ?? '?';
  console.log(`job ${jobId} -> ${consumer}`);
  await sleep(WORK_MS);

  if ((fields.processingType ?? 'OK') !== 'OK') {
    // Failure: do NOT acknowledge. The delivery count climbs, and once it reaches maxDeliver
    // the next sweep routes the job to the DLQ.
    console.log(`${consumer}: job ${jobId} failed, not acknowledging`);
    return;
  }

  // The result first, then the ACK. Two commands, not one transaction: a crash between them
  // re-delivers the job and produces a duplicate result. At-least-once means whatever reads the
  // done stream must be idempotent.
  await client.xAdd(`jobs.done.${consumer}`, '*', fields);
  await client.xAck(STREAM, GROUP, id);
  console.log(`${consumer}: job ${jobId} done`);
}

console.log(`${consumer} connecting to ${url}`);
const client = createClient({ url });
client.on('error', (err) => console.error('redis error:', err.message));
await client.connect();

let iteration = 0;
let idlePolls = 0;
for (;;) {
  iteration += 1;
  const work = await blockingRead(client);
  if (iteration % 2 === 0) {
    work.push(...(await sweep(client)));
  }

  if (work.length === 0) {
    idlePolls += 1;
    console.log(`${consumer}: no new jobs`);
    if (exitAfterIdle && idlePolls >= exitAfterIdle) {
      console.log(`${consumer}: idle ${idlePolls} times, exiting`);
      await client.close();
      break;
    }
    continue;
  }

  idlePolls = 0;
  for (const entry of work) {
    await handle(client, entry);
  }
}
