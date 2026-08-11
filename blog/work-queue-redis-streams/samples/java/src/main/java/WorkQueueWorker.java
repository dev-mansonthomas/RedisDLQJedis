/*
Work Queue on Redis Streams — one competing-consumer worker. Run it twice to see the split.
This sample assumes no prior Redis knowledge.

QUICKSTART — paste the indented lines into a terminal (needs Docker + JDK 21 + Maven):

    git clone https://github.com/dev-mansonthomas/RedisMessagingPatternsWithJedis.git
    cd RedisMessagingPatternsWithJedis
    export REDIS_URL="redis://localhost:$(./blog/work-queue-redis-streams/samples/setup.sh)"
    cd blog/work-queue-redis-streams/samples/java && mvn -q compile exec:java -Dexec.args=worker-1

Then, in a SECOND terminal, the same command with a different consumer name — that is the whole
point of the pattern:

    export REDIS_URL="redis://localhost:6379"   # the port setup.sh printed
    cd RedisMessagingPatternsWithJedis/blog/work-queue-redis-streams/samples/java
    mvn -q compile exec:java -Dexec.args=worker-2

setup.sh loads the Lua function, creates the group and queues 10 jobs; if nothing is listening on
localhost:6379 it starts a throwaway Redis 8.8 in Docker on a free port and prints that port.
Streams and consumer groups are explained from scratch in post #1:
https://github.com/dev-mansonthomas/RedisMessagingPatternsWithJedis/tree/blog-dlq-v1/blog/dlq-redis-streams

The shape of this worker is the one the post argues for:
  - hot path: XREADGROUP … BLOCK 1000, because a blocking read is how you consume a queue;
  - every other iteration: FCALL read_claim_or_dlq, which reclaims entries orphaned by a dead
    worker and routes exhausted ones to the DLQ. It is a separate call because a Lua function
    cannot block.
Both paths return work, and BOTH feed the same handler — the function's last step is itself an
XREADGROUP, so treating its reply as "reclaimed work only" would leak a job that is read and
never acknowledged.

Env:
  REDIS_URL                      default redis://localhost:6379
  SAMPLE_EXIT_AFTER_IDLE_POLLS   unset = run forever (what a real worker does).
                                 Set to N to exit 0 after N polls that found nothing —
                                 that is how the post's verify.sh gets a deterministic run.

There is deliberately NO shutdown hook: killing this process with Ctrl-C while it holds a job is
the crash-recovery demo. The entry stays in the group's pending list and a peer reclaims it after
minIdle. Do not "fix" this by acknowledging on exit.
*/

import redis.clients.jedis.Jedis;
import redis.clients.jedis.resps.StreamEntry;
import redis.clients.jedis.StreamEntryID;
import redis.clients.jedis.params.XAddParams;
import redis.clients.jedis.params.XReadGroupParams;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class WorkQueueWorker {

    static final String STREAM = "jobs.imageProcessing.v1";
    static final String DLQ = "jobs.imageProcessing.v1:dlq";
    static final String GROUP = "jobs-group";

    /** Simulated work. The pace of the demo's SLOW mode, so the numbers here match the article. */
    static final long WORK_MS = 2000;
    /** An entry idle this long is claimable by a peer. MUST outlast WORK_MS — see the post. */
    static final long MIN_IDLE_MS = 5000;
    static final int COUNT = 1;
    static final int MAX_DELIVER = 2;

    public static void main(String[] args) {
        String consumer = args.length > 0 && !args[0].isBlank() ? args[0] : "worker-1";
        String url = System.getenv().getOrDefault("REDIS_URL", "redis://localhost:6379");
        int exitAfterIdle = Integer.parseInt(
                System.getenv().getOrDefault("SAMPLE_EXIT_AFTER_IDLE_POLLS", "0"));

        System.out.printf("%s connecting to %s%n", consumer, url);

        try (Jedis jedis = new Jedis(url)) {
            long iteration = 0;
            int idlePolls = 0;

            while (true) {
                iteration++;
                List<StreamEntry> work = new ArrayList<>(blockingRead(jedis, consumer));

                // Every other iteration (~2 s at this pace) run the catch-up sweep.
                if (iteration % 2 == 0) {
                    work.addAll(sweep(jedis, consumer));
                }

                if (work.isEmpty()) {
                    idlePolls++;
                    System.out.printf("%s: no new jobs%n", consumer);
                    if (exitAfterIdle > 0 && idlePolls >= exitAfterIdle) {
                        System.out.printf("%s: idle %d times, exiting%n", consumer, idlePolls);
                        return;
                    }
                    continue;
                }

                idlePolls = 0;
                for (StreamEntry entry : work) {
                    handle(jedis, consumer, entry);
                }
            }
        }
    }

    /** The hot path: block up to a second waiting for a job nobody has taken. */
    static List<StreamEntry> blockingRead(Jedis jedis, String consumer) {
        Map<String, StreamEntryID> streams =
                Map.of(STREAM, StreamEntryID.XREADGROUP_UNDELIVERED_ENTRY);
        List<Map.Entry<String, List<StreamEntry>>> reply = jedis.xreadGroup(
                GROUP, consumer,
                XReadGroupParams.xReadGroupParams().count(COUNT).block(1000),
                streams);

        List<StreamEntry> out = new ArrayList<>();
        if (reply == null) {
            return out; // BLOCK expired with nothing to read
        }
        for (Map.Entry<String, List<StreamEntry>> perStream : reply) {
            out.addAll(perStream.getValue());
        }
        return out;
    }

    /**
     * The catch-up path: reclaim entries left pending by a dead worker, and route to the DLQ the
     * ones that have burned their delivery budget. Returns [messagesToProcess, dlqPairs] — the
     * messages must go through the same handler as the blocking read.
     */
    @SuppressWarnings("unchecked")
    static List<StreamEntry> sweep(Jedis jedis, String consumer) {
        Object reply = jedis.fcall("read_claim_or_dlq",
                List.of(STREAM, DLQ),
                List.of(GROUP, consumer, String.valueOf(MIN_IDLE_MS),
                        String.valueOf(COUNT), String.valueOf(MAX_DELIVER)));

        List<StreamEntry> out = new ArrayList<>();
        if (!(reply instanceof List<?> parts) || parts.isEmpty()) {
            return out;
        }

        // parts[0] = [[id, [field, value, ...]], ...]
        if (parts.get(0) instanceof List<?> messages) {
            for (Object raw : messages) {
                if (!(raw instanceof List<?> pair) || pair.size() < 2) {
                    continue;
                }
                StreamEntryID id = new StreamEntryID(asString(pair.get(0)));
                Map<String, String> fields = new LinkedHashMap<>();
                List<Object> flat = (List<Object>) pair.get(1);
                for (int i = 0; i + 1 < flat.size(); i += 2) {
                    fields.put(asString(flat.get(i)), asString(flat.get(i + 1)));
                }
                out.add(new StreamEntry(id, fields));
            }
        }

        // parts[1] = [[originalId, dlqId], ...] — jobs that exhausted their retries.
        if (parts.size() > 1 && parts.get(1) instanceof List<?> routed) {
            for (Object raw : routed) {
                if (raw instanceof List<?> pair && pair.size() >= 2) {
                    System.out.printf("%s: DLQ %s -> %s%n",
                            consumer, asString(pair.get(0)), asString(pair.get(1)));
                }
            }
        }
        return out;
    }

    static void handle(Jedis jedis, String consumer, StreamEntry entry) {
        Map<String, String> fields = entry.getFields();
        String jobId = fields.getOrDefault("jobId", "?");
        String type = fields.getOrDefault("processingType", "OK");

        System.out.printf("job %s -> %s%n", jobId, consumer);
        try {
            Thread.sleep(WORK_MS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return; // interrupted mid-job: no ACK, the entry stays pending on purpose
        }

        if (!"OK".equals(type)) {
            // Failure: do NOT acknowledge. The delivery count climbs, and once it reaches
            // maxDeliver the next sweep routes the job to the DLQ.
            System.out.printf("%s: job %s failed, not acknowledging%n", consumer, jobId);
            return;
        }

        // The result first, then the ACK. These are two commands, not one transaction: a crash
        // between them re-delivers the job and produces a duplicate result. At-least-once means
        // whatever reads the done stream must be idempotent.
        jedis.xadd("jobs.done." + consumer, XAddParams.xAddParams(), fields);
        jedis.xack(STREAM, GROUP, entry.getID());
        System.out.printf("%s: job %s done%n", consumer, jobId);
    }

    static String asString(Object o) {
        if (o instanceof byte[] bytes) {
            return new String(bytes);
        }
        return String.valueOf(o);
    }
}
