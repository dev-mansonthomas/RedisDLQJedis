package com.redis.patterns.service;

import tools.jackson.databind.ObjectMapper;
import com.redis.patterns.support.AbstractRedisIntegrationTest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.JedisPoolConfig;
import redis.clients.jedis.StreamEntryID;
import redis.clients.jedis.params.XAddParams;
import redis.clients.jedis.params.XPendingParams;
import redis.clients.jedis.resps.StreamConsumerInfo;
import redis.clients.jedis.resps.StreamEntry;
import redis.clients.jedis.resps.StreamGroupInfo;
import redis.clients.jedis.resps.StreamPendingEntry;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.BooleanSupplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Integration tests for the Work Queue's runtime-adjustable worker pool (slice A of blog post #2).
 *
 * <p>Covers the pool bounds, contiguous worker ids, exactly-once distribution across competing
 * consumers, and the two removal flavors: graceful (the in-flight job completes) and kill (the job
 * stays in the PEL and is recovered by another worker — never {@code XGROUP DELCONSUMER}).
 *
 * <p>Spec: {@code docs/specs/work-queue-dynamic-workers.md}.
 */
class WorkQueueScalingIntegrationTest extends AbstractRedisIntegrationTest {

    private static final String STREAM = WorkQueueService.JOB_STREAM;
    private static final String GROUP = WorkQueueService.JOB_GROUP;
    private static final String DLQ = WorkQueueService.JOB_DLQ;
    private static final String DONE = WorkQueueService.JOB_DONE_PREFIX;

    private JedisPool servicePool;
    private RedisStreamListenerService listener;
    private WorkQueueService service;

    /**
     * Builds the service on a <em>dedicated, larger</em> pool: every {@link RedisStreamListenerService}
     * monitor holds a connection for the whole {@code XREAD BLOCK}, and {@code run()} starts 6
     * monitors plus 4 workers — more concurrent borrowers than the base pool's default maxTotal (8).
     */
    @BeforeEach
    void startService() throws Exception {
        JedisPoolConfig poolConfig = new JedisPoolConfig();
        poolConfig.setMaxTotal(64);
        poolConfig.setMaxIdle(64);
        servicePool = new JedisPool(poolConfig, REDIS_HOST, redisPort);

        try (var jedis = servicePool.getResource()) {
            jedis.functionLoadReplace(Files.readString(Path.of("lua/stream_utils.lua")));
        }

        var webSocketEventService = new WebSocketEventService(new ObjectMapper());
        listener = new RedisStreamListenerService(servicePool, webSocketEventService);
        service = new WorkQueueService(servicePool, webSocketEventService, listener);
        service.run();
    }

    /**
     * Without this, the previous test's workers keep polling the shared container and steal the next
     * test's jobs (the base class only flushes the keyspace between tests).
     */
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
    void startsWithFourWorkersAndExposesTheirStreams() {
        assertThat(service.workerCount()).isEqualTo(4);
        assertThat(service.getWorkerState())
                .containsEntry("count", 4)
                .containsEntry("min", 1)
                .containsEntry("max", 8);

        Map<String, Object> names = service.getStreamNames();
        assertThat(names)
                .containsEntry("jobStream", STREAM)
                .containsEntry("dlqStream", DLQ)
                .containsEntry("group", GROUP);

        assertThat(doneStreams(names))
                .containsExactly(DONE + "1", DONE + "2", DONE + "3", DONE + "4");
    }

    @Test
    void boundsAreEnforced() {
        for (int expected = 5; expected <= WorkQueueService.MAX_WORKERS; expected++) {
            assertThat(service.addWorker()).isEqualTo(expected);
        }
        assertThat(service.workerCount()).isEqualTo(8);
        assertThatThrownBy(() -> service.addWorker())
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("maximum");
        assertThat(service.workerCount()).isEqualTo(8);
        assertThat(doneStreams(service.getStreamNames())).hasSize(8).endsWith(DONE + "8");

        for (int expected = 7; expected >= WorkQueueService.MIN_WORKERS; expected--) {
            assertThat(service.removeWorker(false)).isEqualTo(expected);
        }
        assertThat(service.workerCount()).isEqualTo(1);
        assertThatThrownBy(() -> service.removeWorker(false))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("minimum");
        assertThat(service.workerCount()).isEqualTo(1);
        assertThat(doneStreams(service.getStreamNames())).containsExactly(DONE + "1");
    }

    /**
     * Exactly-once across competing consumers, plus proof that the runtime-added worker really is a
     * group member. We assert membership via {@code XINFO CONSUMERS} (deterministic: {@code XREADGROUP}
     * registers the consumer on its first call, even when it returns nothing) rather than asserting
     * how the 20 jobs happened to be split, which would depend on scheduling luck.
     */
    @Test
    void everyJobIsProcessedExactlyOnceAcrossWorkers() {
        service.pollIntervalMs = 20;
        service.processingSleepMs = 5;
        assertThat(service.addWorker()).isEqualTo(5);
        awaitUntil(Duration.ofSeconds(5), "worker-5 registered in the group",
                () -> consumerNames().contains("worker-5"));

        List<String> produced = new ArrayList<>();
        for (int i = 1; i <= 20; i++) {
            String jobId = "JOB-" + i;
            service.produceJob(jobId, "OK", null);
            produced.add(jobId);
        }

        awaitUntil(Duration.ofSeconds(15), "20 jobs in the done streams", () -> doneJobIds().size() >= 20);

        assertThat(doneJobIds()).containsExactlyInAnyOrderElementsOf(produced);
        assertThat(pendingTotal()).isZero();
    }

    @Test
    void gracefulRemoveFinishesTheInFlightJob() {
        twoWorkersEachHoldingAJob();

        assertThat(service.removeWorker(false)).isEqualTo(1);

        // The call returns only once the loop exited, which happens after the in-flight job was
        // copied to the done stream and XACKed.
        assertThat(xlen(DONE + "2")).isEqualTo(1);
        awaitUntil(Duration.ofSeconds(10), "PEL drained", () -> pendingTotal() == 0);
        assertThat(doneJobIds()).containsExactlyInAnyOrder("JOB-A", "JOB-B");
    }

    /**
     * The crash demo: killing a worker mid-job must not lose the job, and must not evict the consumer
     * from the group ({@code XGROUP DELCONSUMER} would drop its PEL entries).
     *
     * <p>Deterministic window: worker-1 is parked in its own 2 s processing sleep, so it cannot claim
     * worker-2's orphaned entry before the assertions run (~50 ms later). Together with
     * {@link #gracefulRemoveFinishesTheInFlightJob} — same setup, opposite outcome — this proves the
     * assertions discriminate between the two removal flavors.
     */
    @Test
    void killedWorkerLeavesTheJobPendingAndKeepsTheConsumer() {
        twoWorkersEachHoldingAJob();
        StreamEntryID killedJob = pendingEntryOf("worker-2").getID();

        assertThat(service.removeWorker(true)).isEqualTo(1);

        assertThat(xlen(DONE + "2")).isZero();
        StreamPendingEntry stillPending = pendingEntries().stream()
                .filter(entry -> entry.getID().equals(killedJob))
                .findFirst()
                .orElseThrow(() -> new AssertionError("the killed worker's job vanished from the PEL"));
        assertThat(stillPending.getDeliveredTimes()).isEqualTo(1);
        assertThat(consumerNames()).contains("worker-2");
    }

    @Test
    void theKilledWorkersJobIsRecoveredByAnotherWorker() {
        twoWorkersEachHoldingAJob();
        service.removeWorker(true);

        // Recovery happens once the orphaned entry has been idle for MIN_IDLE_MS: the claim path in
        // read_claim_or_dlq hands it to whoever polls next.
        service.processingSleepMs = 20;
        assertThat(service.addWorker()).isEqualTo(2);

        awaitUntil(Duration.ofSeconds(10), "both jobs done and the PEL drained",
                () -> doneJobIds().size() == 2 && pendingTotal() == 0);
        assertThat(doneJobIds()).containsExactlyInAnyOrder("JOB-A", "JOB-B");
    }

    /**
     * Characterizes the pattern's central tuning constraint: {@code minIdle} must exceed the maximum
     * processing time. Here processing (800 ms) outlasts it (100 ms — the pre-2026-08-03 default, set
     * explicitly so this test does not depend on the shipped mode), so the <em>free</em> worker claims
     * the job its busy peer is still working on and the job is processed <strong>twice</strong>,
     * silently — no error, empty PEL, empty DLQ.
     *
     * <p>Not hypothetical: with those defaults a live run of the page duplicated 120 of 266 completed
     * jobs. Both shipped demo modes now keep a 2x+ margin, which
     * {@link #neitherShippedModeLetsAFreeWorkerStealAnInFlightJob} verifies. Blog post #2 states the rule.
     *
     * <p>See docs/TODO.md; {@code TokenBucketService} documents the same rule for {@code XAUTOCLAIM}.
     */
    @Test
    void aFreeWorkerStealsAnInFlightJobWhenProcessingExceedsMinIdle() {
        service.pollIntervalMs = 20;
        service.minIdleMs = 100;
        service.processingSleepMs = 800;   // > minIdleMs
        while (service.workerCount() > 2) {
            service.removeWorker(false);
        }

        service.produceJob("JOB-X", "OK", null);

        awaitUntil(Duration.ofSeconds(10), "the job to be processed twice", () -> doneJobIds().size() == 2);
        assertThat(doneJobIds()).containsExactly("JOB-X", "JOB-X");
        assertThat(pendingTotal()).isZero();
        assertThat(xlen(DLQ)).isZero();
    }

    /**
     * The regression guard for the duplication above: with a free peer available and a job in flight for
     * the mode's full work time, each shipped mode must still produce <strong>exactly one</strong> done
     * entry. Two workers, one job — worker-2 is idle throughout and could steal it if the margin were gone.
     */
    @ParameterizedTest
    @EnumSource(WorkQueueService.DemoMode.class)
    void neitherShippedModeLetsAFreeWorkerStealAnInFlightJob(WorkQueueService.DemoMode mode) {
        service.applyDemoMode(mode);
        while (service.workerCount() > 2) {
            service.removeWorker(false);
        }

        service.produceJob("JOB-SOLO", "OK", null);

        awaitUntil(Duration.ofSeconds(15), "the job done and the PEL drained",
                () -> doneJobIds().size() >= 1 && pendingTotal() == 0);
        // A thief's duplicate lands at most one poll + one work time after the original's XACK
        // (that is how it shows up in aFreeWorkerStealsAnInFlightJobWhenProcessingExceedsMinIdle),
        // so wait that out before concluding there is none.
        sleep(mode.workMs() + mode.pollMs() + 200);
        assertThat(doneJobIds()).containsExactly("JOB-SOLO");
    }

    /**
     * A burst builds a real backlog and the pool drains it exactly once — the property the throughput
     * counter reports on. Uses 40 jobs so the queue genuinely outruns the workers at first (40 jobs, 8
     * workers, ~25 ms each) instead of being produced as fast as it is consumed.
     */
    @Test
    void aBurstIsProducedInOneTripAndDrainedExactlyOnce() {
        service.pollIntervalMs = 20;
        service.processingSleepMs = 5;
        service.minIdleMs = 500;
        assertThat(service.addWorker()).isEqualTo(5);

        List<String> messageIds = service.produceBurst(40);

        assertThat(messageIds).hasSize(40).doesNotHaveDuplicates();
        assertThat(xlen(STREAM)).as("all 40 jobs are in the stream").isEqualTo(40);

        // 4 of the 40 are Error (every 10th) and end in the DLQ; the other 36 complete.
        awaitUntil(Duration.ofSeconds(30), "36 jobs done and 4 in the DLQ",
                () -> doneJobIds().size() >= 36 && xlen(DLQ) == 4);
        sleep(300);
        assertThat(doneJobIds()).as("no job processed twice").doesNotHaveDuplicates().hasSize(36);
        assertThat(pendingTotal()).isZero();
    }

    @Test
    void aBurstOutsideItsBoundsIsRejectedWithoutProducing() {
        assertThatThrownBy(() -> service.produceBurst(0))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("between 1 and " + WorkQueueService.MAX_BURST);
        assertThatThrownBy(() -> service.produceBurst(WorkQueueService.MAX_BURST + 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(xlen(STREAM)).isZero();
    }

    /**
     * Switching mode retimes the <em>running</em> pool: no restart, no worker respawn. Proven by pace —
     * in SLOW a job cannot possibly be done within 1 s (2 s of simulated work), in FAST it is done well
     * inside that window — and by the timings the service then reports to the UI.
     */
    @Test
    void switchingDemoModeRetimesTheRunningPoolWithoutRestart() {
        int countBefore = service.workerCount();

        service.applyDemoMode(WorkQueueService.DemoMode.SLOW);
        assertThat(service.getDemoModeState())
                .containsEntry("mode", "SLOW")
                .containsEntry("workMs", 2000L)
                .containsEntry("minIdleMs", 5000L);
        assertThat(service.workerCount()).as("the pool is not respawned").isEqualTo(countBefore);

        service.produceJob("JOB-SLOW", "OK", null);
        sleep(1000);
        assertThat(doneJobIds()).as("2 s of simulated work cannot finish in 1 s").isEmpty();
        awaitUntil(Duration.ofSeconds(15), "the slow job to finish", () -> doneJobIds().contains("JOB-SLOW"));

        service.applyDemoMode(WorkQueueService.DemoMode.FAST);
        assertThat(service.getDemoModeState())
                .containsEntry("mode", "FAST")
                .containsEntry("workMs", 50L)
                .containsEntry("minIdleMs", 500L);

        service.produceJob("JOB-FAST", "OK", null);
        awaitUntil(Duration.ofSeconds(5), "the fast job to finish", () -> doneJobIds().contains("JOB-FAST"));
    }

    /**
     * The retry budget and DLQ routing still work with a runtime-sized pool.
     *
     * <p>Uses the demo's own failure path (a {@code processingType=Error} job is never ACKed) rather
     * than "kill the same worker twice": with {@code MIN_WORKERS = 1} the last holder can never be
     * killed, so a free worker always ends up reclaiming and completing the job. That a kill costs one
     * delivery is proven separately by
     * {@link #killedWorkerLeavesTheJobPendingAndKeepsTheConsumer} ({@code deliveredTimes == 1}).
     */
    @Test
    void aFailingJobIsRoutedToTheDlqAfterItsRetryBudget() {
        service.pollIntervalMs = 20;

        service.produceJob("JOB-ERR", "Error", null);

        awaitUntil(Duration.ofSeconds(10), "the failing job in the DLQ", () -> xlen(DLQ) == 1);
        assertThat(pendingTotal()).isZero();
        assertThat(doneJobIds()).isEmpty();
        try (var jedis = jedisPool.getResource()) {
            assertThat(jedis.xrange(DLQ, "-", "+", 10).getFirst().getFields())
                    .containsEntry("jobId", "JOB-ERR");
        }
    }

    /**
     * {@code clear} must wipe every done stream the pool could ever have used, not just the ones the
     * current count covers — otherwise shrinking the pool leaves orphan streams behind. The leftovers
     * are written directly with {@code XADD} so the test does not depend on how jobs get distributed.
     */
    @Test
    void clearDeletesDoneStreamsBeyondTheCurrentWorkerCount() {
        try (var jedis = jedisPool.getResource()) {
            for (int i = 1; i <= WorkQueueService.MAX_WORKERS; i++) {
                jedis.xadd(DONE + i, XAddParams.xAddParams(), Map.of("jobId", "LEFTOVER-" + i));
            }
        }
        while (service.workerCount() > 2) {
            service.removeWorker(false);
        }

        service.clearAllStreams();

        for (int i = 1; i <= WorkQueueService.MAX_WORKERS; i++) {
            assertThat(xlen(DONE + i)).as("done stream of worker-%d", i).isZero();
        }
        assertThat(xlen(STREAM)).isZero();
        assertThat(xlen(DLQ)).isZero();
        try (var jedis = jedisPool.getResource()) {
            assertThat(jedis.xinfoGroups(STREAM)).extracting(StreamGroupInfo::getName).contains(GROUP);
        }
    }

    // --- helpers -----------------------------------------------------------------------------

    /**
     * Leaves the pool at 2 workers, each holding one job, with a 2 s processing window.
     *
     * <p>Deterministic because the worker loop is serialized: worker-1 takes JOB-A and is then parked
     * for 2 s, so it cannot also take JOB-B — worker-2 must. This matters because
     * {@code removeWorker} always removes the highest-id worker, so the test needs worker-2 to be the
     * one holding a job.
     */
    private void twoWorkersEachHoldingAJob() {
        service.pollIntervalMs = 20;
        service.processingSleepMs = 2000;
        // Both workers are busy at the same time, so neither is free to claim the other's entry — see
        // aFreeWorkerStealsAnInFlightJobWhenProcessingExceedsMinIdle for what happens when one is idle.
        while (service.workerCount() > 2) {
            service.removeWorker(false);
        }

        service.produceJob("JOB-A", "OK", null);
        service.produceJob("JOB-B", "OK", null);

        awaitUntil(Duration.ofSeconds(10), "worker-1 and worker-2 each holding a job",
                () -> pendingEntries().stream().map(StreamPendingEntry::getConsumerName).toList()
                        .containsAll(List.of("worker-1", "worker-2")));
    }

    private static StreamPendingEntry pendingEntryOf(String consumer) {
        return pendingEntries().stream()
                .filter(entry -> consumer.equals(entry.getConsumerName()))
                .findFirst()
                .orElseThrow(() -> new AssertionError("no pending entry owned by " + consumer));
    }

    private static List<StreamPendingEntry> pendingEntries() {
        try (var jedis = jedisPool.getResource()) {
            return jedis.xpending(STREAM, GROUP, XPendingParams.xPendingParams(
                    StreamEntryID.MINIMUM_ID, StreamEntryID.MAXIMUM_ID, 100));
        }
    }

    private static long xlen(String stream) {
        try (var jedis = jedisPool.getResource()) {
            return jedis.xlen(stream);
        }
    }


    @SuppressWarnings("unchecked")
    private static List<String> doneStreams(Map<String, Object> streamNames) {
        return (List<String>) streamNames.get("doneStreams");
    }

    /** Every jobId present in any worker's done stream — duplicates included, so we can prove there are none. */
    private static List<String> doneJobIds() {
        List<String> jobIds = new ArrayList<>();
        try (var jedis = jedisPool.getResource()) {
            for (int i = 1; i <= WorkQueueService.MAX_WORKERS; i++) {
                for (StreamEntry entry : jedis.xrange(DONE + i, "-", "+", 1000)) {
                    jobIds.add(entry.getFields().get("jobId"));
                }
            }
        }
        return jobIds;
    }

    /** Consumer names currently registered in the group (a removed worker must still appear here). */
    private static List<String> consumerNames() {
        try (var jedis = jedisPool.getResource()) {
            return jedis.xinfoConsumers(STREAM, GROUP).stream()
                    .map(StreamConsumerInfo::getName)
                    .toList();
        }
    }

    private static long pendingTotal() {
        try (var jedis = jedisPool.getResource()) {
            return jedis.xpending(STREAM, GROUP).getTotal();
        }
    }

    /** Uninterruptible-ish pause, for the "prove it did NOT happen" assertions. */
    private static void sleep(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** Polls {@code condition} every 5 ms until it holds, or fails the test. No new dependency. */
    private static void awaitUntil(Duration timeout, String what, BooleanSupplier condition) {
        Instant deadline = Instant.now().plus(timeout);
        while (Instant.now().isBefore(deadline)) {
            if (condition.getAsBoolean()) {
                return;
            }
            try {
                Thread.sleep(5);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        throw new AssertionError("Timed out after " + timeout + " waiting for: " + what);
    }
}
