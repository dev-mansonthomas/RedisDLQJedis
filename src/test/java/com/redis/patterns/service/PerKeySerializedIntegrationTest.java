package com.redis.patterns.service;

import com.redis.patterns.support.AbstractRedisIntegrationTest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.JedisPoolConfig;
import redis.clients.jedis.StreamEntryID;
import tools.jackson.databind.ObjectMapper;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.function.BooleanSupplier;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Integration tests for Per-Key Serialized processing: jobs sharing a key run one at a time, jobs on
 * different keys run in parallel. The lock is a {@code SET NX} on {@code running:order:{id}}.
 *
 * <p>Both halves are asserted from observable timing, because that is the only way the guarantee is
 * visible from outside: three jobs on one key must take at least 3 × the processing time, while three
 * jobs on three keys must finish in roughly one processing time on a 3-worker pool.
 *
 * <p>Spec: {@code docs/specs/per-key-serialized.md}.
 */
class PerKeySerializedIntegrationTest extends AbstractRedisIntegrationTest {

    /** Matches {@code PerKeySerializedService.PROCESSING_SLEEP_MS}. */
    private static final long WORK_MS = 4_000;
    private static final int WORKERS = 3;

    private JedisPool servicePool;
    private PerKeySerializedService service;
    private RedisStreamListenerService listener;

    @BeforeEach
    void startService() throws Exception {
        JedisPoolConfig config = new JedisPoolConfig();
        config.setMaxTotal(64);
        config.setMaxIdle(64);
        servicePool = new JedisPool(config, REDIS_HOST, redisPort);
        // The lock is released through the registered `release_lock` function, so the library must be
        // loaded or every lock survives until its 30s TTL and same-key throughput collapses.
        try (var jedis = servicePool.getResource()) {
            jedis.functionLoadReplace(java.nio.file.Files.readString(java.nio.file.Path.of("lua/stream_utils.lua")));
        }
        var ws = new WebSocketEventService(new ObjectMapper());
        listener = new RedisStreamListenerService(servicePool, ws);
        service = new PerKeySerializedService(servicePool, ws, listener);
        service.run();
    }

    @AfterEach
    void stopService() {
        if (service != null) {
            service.stopWorkers();
        }
        if (listener != null) {
            listener.shutdown();
        }
        if (servicePool != null) {
            servicePool.close();
        }
    }

    @Test
    void threeJobsOnTheSameKeyRunOneAtATime() throws Exception {
        submit("ORDER-1", "validate", "charge", "ship");

        awaitTrue(() -> doneCount() == 3, Duration.ofSeconds(60), "the three same-key jobs to finish");

        List<Instant> finished = completionInstants();
        assertThat(finished).hasSize(3);
        // Serialized: each completion is at least one processing window after the previous one.
        // A 500ms tolerance absorbs poll jitter without ever tolerating a parallel run (which would
        // put the gaps near zero).
        for (int i = 1; i < finished.size(); i++) {
            long gapMs = Duration.between(finished.get(i - 1), finished.get(i)).toMillis();
            assertThat(gapMs)
                .as("completion %d follows %d by a full processing window — two jobs on ORDER-1 "
                    + "overlapping is exactly what the lock exists to prevent", i, i - 1)
                .isGreaterThan(WORK_MS - 500);
        }
    }

    @Test
    void jobsOnDifferentKeysRunInParallel() throws Exception {
        Instant start = Instant.now();
        submitDistinct("ORDER-A", "ORDER-B", "ORDER-C");

        awaitTrue(() -> doneCount() == 3, Duration.ofSeconds(60), "the three distinct-key jobs to finish");

        long elapsedMs = Duration.between(start, Instant.now()).toMillis();
        assertThat(elapsedMs)
            .as("three keys on %d workers overlap, so the wall clock stays near one processing "
                + "window (%dms) rather than three", WORKERS, WORK_MS)
            .isLessThan(3 * WORK_MS);
        assertThat(distinctWorkers())
            .as("the work really was spread across workers")
            .isGreaterThan(1);
    }

    @Test
    void noJobIsProcessedTwice() throws Exception {
        submit("ORDER-9", "validate", "charge");
        submitDistinct("ORDER-X", "ORDER-Y");

        awaitTrue(() -> doneCount() == 4, Duration.ofSeconds(60), "all four jobs to finish");
        Thread.sleep(2_000); // let a duplicate show up if the claim path re-delivers

        List<String> jobs = doneEntries().stream()
            .map(f -> f.get("orderId") + "/" + f.get("action"))
            .toList();
        assertThat(jobs)
            .as("RECLAIM_MIN_IDLE_MS (10s) is 2.5x the processing time (4s), so no free worker "
                + "should ever claim a job a busy peer still holds")
            .doesNotHaveDuplicates();
        assertThat(pendingCount()).as("everything ACKed").isZero();
    }

    @Test
    void theLockIsReleasedAfterProcessingSoTheKeyIsUsableAgain() throws Exception {
        submit("ORDER-2", "validate");
        awaitTrue(() -> doneCount() == 1, Duration.ofSeconds(60), "the job to finish");

        try (var jedis = servicePool.getResource()) {
            assertThat(jedis.exists("running:order:ORDER-2"))
                .as("a lock left behind would deadlock the key until its 30s TTL expired")
                .isFalse();
        }
    }

    private void submit(String orderId, String... actions) {
        List<Map<String, String>> jobs = new ArrayList<>();
        for (String action : actions) {
            jobs.add(Map.of("orderId", orderId, "action", action));
        }
        service.submitJobs(jobs);
    }

    private void submitDistinct(String... orderIds) {
        List<Map<String, String>> jobs = new ArrayList<>();
        for (String orderId : orderIds) {
            jobs.add(Map.of("orderId", orderId, "action", "validate"));
        }
        service.submitJobs(jobs);
    }

    private List<Map<String, String>> doneEntries() {
        List<Map<String, String>> all = new ArrayList<>();
        try (var jedis = servicePool.getResource()) {
            for (int worker = 1; worker <= WORKERS; worker++) {
                String stream = PerKeySerializedService.WORKER_DONE_PREFIX + worker + ".done";
                if (jedis.exists(stream)) {
                    jedis.xrange(stream, (StreamEntryID) null, (StreamEntryID) null, 1000)
                        .forEach(e -> all.add(e.getFields()));
                }
            }
        }
        return all;
    }

    private List<Instant> completionInstants() {
        return doneEntries().stream()
            .map(f -> Instant.parse(f.get("processedAt")))
            .sorted(Comparator.naturalOrder())
            .toList();
    }

    private long distinctWorkers() {
        return doneEntries().stream().map(f -> f.get("processedBy")).distinct().count();
    }

    private int doneCount() {
        return doneEntries().size();
    }

    private long pendingCount() {
        try (var jedis = servicePool.getResource()) {
            var info = jedis.xpending(PerKeySerializedService.JOB_STREAM, PerKeySerializedService.JOB_GROUP);
            return info == null ? 0 : info.getTotal();
        }
    }

    private void awaitTrue(BooleanSupplier condition, Duration timeout, String what) throws Exception {
        Instant deadline = Instant.now().plus(timeout);
        while (Instant.now().isBefore(deadline)) {
            if (condition.getAsBoolean()) {
                return;
            }
            Thread.sleep(200);
        }
        throw new AssertionError("Timed out waiting for " + what);
    }
}
