package com.redis.patterns.service;

import com.redis.patterns.dto.DLQEvent;
import jakarta.annotation.PreDestroy;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.CommandLineRunner;
import org.springframework.stereotype.Service;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.StreamEntryID;
import redis.clients.jedis.params.XAddParams;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.IntStream;

/**
 * Service implementing the Work Queue / Competing Consumers pattern.
 * 
 * Features:
 * - 1 to 8 worker Virtual Threads processing jobs in parallel (4 at startup, adjustable at runtime)
 * - Uses read_claim_or_dlq Lua function for atomic claim + DLQ routing
 * - Jobs with processingType=Error are not acknowledged (go to DLQ after 2 attempts)
 * - Jobs with processingType=OK are copied to worker-specific "done" streams
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class WorkQueueService implements CommandLineRunner {

    private final JedisPool jedisPool;
    private final WebSocketEventService webSocketEventService;
    private final RedisStreamListenerService streamListenerService;

    // Stream names
    public static final String JOB_STREAM = "jobs.imageProcessing.v1";
    public static final String JOB_GROUP = "jobs-group";
    public static final String JOB_DLQ = "jobs.imageProcessing.v1:dlq";
    public static final String JOB_DONE_PREFIX = "jobs.done.worker-";

    // Configuration
    public static final int MIN_WORKERS = 1;
    public static final int MAX_WORKERS = 8;
    public static final int INITIAL_WORKERS = 4;
    private static final int MAX_DELIVERIES = 2;

    /**
     * Timing preset driving the demo's pace. Two, chosen for the two ways the page gets watched.
     *
     * <ul>
     *   <li>{@link #SLOW} — step-by-step narration: a job visibly occupies a worker for 2 s, and a
     *       killed worker's job sits PENDING for 5 s before a peer reclaims it, long enough to point at.</li>
     *   <li>{@link #FAST} — the counters climb: 50 ms per job, retry and DLQ routing land inside a second.</li>
     * </ul>
     *
     * <p><strong>Invariant, enforced in the constructor: {@code minIdleMs >= 2 * workMs}.</strong>
     * When {@code minIdle} does not outlast processing, a <em>free</em> worker claims a job its busy
     * peer is still working on and the job runs twice, silently — no error, empty PEL, empty DLQ.
     * This is not theoretical: the pre-2026-08-03 defaults (100 ms work, 100 ms {@code minIdle}) left
     * zero margin and duplicated <strong>120 of 266</strong> completed jobs in a live run of the demo.
     * Characterized by {@code WorkQueueScalingIntegrationTest#aFreeWorkerStealsAnInFlightJobWhenProcessingExceedsMinIdle};
     * see docs/TODO.md.
     *
     * <p>{@code producerSleepMs} is <em>advisory</em>: the producer loop lives in the browser, so the
     * frontend applies it to its own "sleep between jobs" control when the mode changes.
     *
     * <p>{@code burstSize} is the mode's one-click backlog (see {@link #produceBurst(int)}), sized so the
     * drain is watchable: 20 jobs at 2 s each, 200 at 50 ms each.
     */
    public enum DemoMode {
        /** Watchable one job at a time. Capacity with 4 workers ≈ 1.6 jobs/s. */
        SLOW("Slow", 2000, 5000, 500, 2000, 20),
        /** Counters climb. Capacity with 4 workers ≈ 40 jobs/s; the browser producer is the real ceiling. */
        FAST("Fast", 50, 500, 50, 100, 200);

        private final String label;
        private final long workMs;
        private final long minIdleMs;
        private final long pollMs;
        private final long producerSleepMs;
        private final int burstSize;

        DemoMode(String label, long workMs, long minIdleMs, long pollMs, long producerSleepMs, int burstSize) {
            if (minIdleMs < 2 * workMs) {
                throw new IllegalArgumentException("Demo mode " + label + " breaks the minIdle invariant: "
                    + "minIdleMs (" + minIdleMs + ") must be at least 2x workMs (" + workMs + ")");
            }
            this.label = label;
            this.workMs = workMs;
            this.minIdleMs = minIdleMs;
            this.pollMs = pollMs;
            this.producerSleepMs = producerSleepMs;
            this.burstSize = burstSize;
        }

        public String label() { return label; }
        public long workMs() { return workMs; }
        public long minIdleMs() { return minIdleMs; }
        public long pollMs() { return pollMs; }
        public long producerSleepMs() { return producerSleepMs; }
        public int burstSize() { return burstSize; }

        /** The numbers the UI puts in its dropdown label. Keys match the frontend's DemoModeDescriptor. */
        public Map<String, Object> describe() {
            return Map.of(
                "name", name(),
                "label", label,
                "workMs", workMs,
                "minIdleMs", minIdleMs,
                "pollMs", pollMs,
                "producerSleepMs", producerSleepMs,
                "burstSize", burstSize);
        }
    }

    /** Mode applied at startup. FAST, because a first-time visitor should see something happen. */
    public static final DemoMode DEFAULT_DEMO_MODE = DemoMode.FAST;

    private volatile DemoMode demoMode = DEFAULT_DEMO_MODE;

    // Effective timing. Driven by {@link #applyDemoMode}; also written directly by integration tests
    // (package-private) to widen the "job in flight" window — see WorkQueueScalingIntegrationTest.
    // volatile: written by the request/test thread, read by the worker Virtual Threads.
    volatile long pollIntervalMs = DEFAULT_DEMO_MODE.pollMs();
    volatile long processingSleepMs = DEFAULT_DEMO_MODE.workMs();

    /**
     * Idle time after which a pending entry becomes claimable by another worker — the {@code minIdle}
     * argument of {@code read_claim_or_dlq}. Must outlast {@link #processingSleepMs}; see {@link DemoMode}.
     */
    volatile long minIdleMs = DEFAULT_DEMO_MODE.minIdleMs();

    // Lua function
    private static final String FUNCTION_NAME = "read_claim_or_dlq";

    /** A running worker: its Virtual Thread plus the flag its loop checks. */
    private record WorkerHandle(Thread thread, AtomicBoolean running) {}

    // Worker management — worker ids are always contiguous 1..size(); this map is the source of
    // truth for the current count. Guarded by `this` for add/remove (see addWorker/removeWorker).
    private final Map<Integer, WorkerHandle> workers = new ConcurrentHashMap<>();
    private final AtomicBoolean shutdown = new AtomicBoolean(false);

    @Override
    public void run(String... args) throws Exception {
        log.info("Starting Work Queue Service with {} workers in {} demo mode (work={}ms, minIdle={}ms, poll={}ms)",
            INITIAL_WORKERS, demoMode, processingSleepMs, minIdleMs, pollIntervalMs);

        // Initialize consumer group
        initializeConsumerGroup();

        // Start monitoring job streams for WebSocket broadcasts
        streamListenerService.startMonitoring(JOB_STREAM);
        streamListenerService.startMonitoring(JOB_DLQ);

        // Start workers (each registers monitoring for its own done stream)
        for (int i = 1; i <= INITIAL_WORKERS; i++) {
            spawnWorker(i);
        }

        log.info("Work Queue Service started successfully");
    }

    /**
     * Initialize the consumer group for the job stream.
     */
    private void initializeConsumerGroup() {
        try (var jedis = jedisPool.getResource()) {
            RedisStreamSupport.ensureGroup(jedis, JOB_STREAM, JOB_GROUP, new StreamEntryID());
        }
    }

    /**
     * Start a worker Virtual Thread and register it in {@link #workers}.
     *
     * <p>Also starts monitoring the worker's done stream so the UI sees its output.
     * {@link RedisStreamListenerService#startMonitoring(String)} is idempotent, so re-adding a
     * previously removed worker is a no-op there.
     */
    private void spawnWorker(int workerId) {
        streamListenerService.startMonitoring(JOB_DONE_PREFIX + workerId);

        AtomicBoolean running = new AtomicBoolean(true);
        Thread thread = Thread.ofVirtual()
            .name("work-queue-worker-" + workerId)
            .start(() -> workerLoop(workerId, running));
        workers.put(workerId, new WorkerHandle(thread, running));

        log.info("Started worker-{}", workerId);
    }

    /**
     * Worker loop - polls for jobs and processes them.
     */
    private void workerLoop(int workerId, AtomicBoolean running) {
        String consumerName = consumerName(workerId);
        String doneStream = JOB_DONE_PREFIX + workerId;
        
        while (running.get() && !shutdown.get()) {
            try {
                processNextJob(workerId, consumerName, doneStream);
                Thread.sleep(pollIntervalMs);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception e) {
                // Shutting down: Spring closes the JedisPool before these worker threads
                // notice, so the resulting pool error is expected, not a failure.
                if (shutdown.get()) break;
                log.error("Worker-{} error: {}", workerId, e.getMessage());
                try {
                    Thread.sleep(1000); // Back off on error
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }
        log.info("Worker-{} stopped", workerId);
    }

    /**
     * Process the next available job.
     */
    private void processNextJob(int workerId, String consumerName, String doneStream) {
        try (var jedis = jedisPool.getResource()) {
            // Call read_claim_or_dlq Lua function
            Object result = jedis.fcall(
                FUNCTION_NAME,
                Arrays.asList(JOB_STREAM, JOB_DLQ),
                Arrays.asList(JOB_GROUP, consumerName, String.valueOf(minIdleMs), "1", String.valueOf(MAX_DELIVERIES))
            );
            
            if (!(result instanceof List)) return;
            
            @SuppressWarnings("unchecked")
            List<Object> resultList = (List<Object>) result;
            if (resultList.size() < 2) return;
            
            // Process DLQ messages (broadcast deletion events)
            processDLQMessages(resultList.get(1));
            
            // Process messages to work on
            @SuppressWarnings("unchecked")
            List<Object> messages = (List<Object>) resultList.get(0);

            for (Object msgItem : messages) {
                processMessage(jedis, workerId, consumerName, doneStream, msgItem);
            }
        }
    }

    /**
     * Process DLQ messages - broadcast deletion events.
     */
    private void processDLQMessages(Object dlqResult) {
        if (!(dlqResult instanceof List)) return;

        @SuppressWarnings("unchecked")
        List<Object> dlqMessages = (List<Object>) dlqResult;

        for (Object dlqItem : dlqMessages) {
            if (dlqItem instanceof List) {
                @SuppressWarnings("unchecked")
                List<Object> dlqEntry = (List<Object>) dlqItem;
                if (dlqEntry.size() >= 2) {
                    String originalId = convertToString(dlqEntry.get(0));
                    String dlqId = convertToString(dlqEntry.get(1));
                    log.info("Job {} routed to DLQ with ID {}", originalId, dlqId);

                    webSocketEventService.broadcastEvent(DLQEvent.builder()
                        .eventType(DLQEvent.EventType.MESSAGE_DELETED)
                        .messageId(originalId)
                        .streamName(JOB_STREAM)
                        .details("Job routed to DLQ (max deliveries reached)")
                        .build());
                }
            }
        }
    }

    /**
     * Process a single message.
     */
    @SuppressWarnings("unchecked")
    private void processMessage(redis.clients.jedis.Jedis jedis, int workerId, String consumerName,
                                String doneStream, Object msgItem) {
        if (!(msgItem instanceof List)) return;

        List<Object> msgEntry = (List<Object>) msgItem;
        if (msgEntry.size() < 2) return;

        String messageId = convertToString(msgEntry.get(0));
        List<Object> fieldsList = (List<Object>) msgEntry.get(1);

        // Parse fields
        Map<String, String> fields = new HashMap<>();
        for (int i = 0; i < fieldsList.size(); i += 2) {
            String key = convertToString(fieldsList.get(i));
            String value = convertToString(fieldsList.get(i + 1));
            fields.put(key, value);
        }

        String processingType = fields.getOrDefault("processingType", "OK");
        String jobId = fields.getOrDefault("jobId", "unknown");

        log.debug("Worker-{} processing job {} (type={})", workerId, jobId, processingType);

        try {
            // Simulate processing time
            Thread.sleep(processingSleepMs);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return;
        }

        if ("OK".equals(processingType)) {
            // Success: copy to done stream and ACK.
            // At-least-once: XADD-done and XACK are not atomic. A crash between them re-delivers
            // the job (claimed via read_claim_or_dlq after minIdleMs), producing a duplicate done
            // entry and possibly a DLQ route after MAX_DELIVERIES — downstream consumers must be idempotent.
            jedis.xadd(doneStream, XAddParams.xAddParams(), fields);
            jedis.xack(JOB_STREAM, JOB_GROUP, new StreamEntryID(messageId));

            log.info("Worker-{} completed job {} successfully", workerId, jobId);

            // Broadcast deletion from job stream
            webSocketEventService.broadcastEvent(DLQEvent.builder()
                .eventType(DLQEvent.EventType.MESSAGE_DELETED)
                .messageId(messageId)
                .streamName(JOB_STREAM)
                .details("Job completed by worker-" + workerId)
                .build());
        } else {
            // Error: do NOT acknowledge - will be retried or go to DLQ
            log.warn("Worker-{} failed to process job {} (will retry)", workerId, jobId);
        }
    }

    /** Upper bound on one burst, so a stray request cannot queue unbounded work. */
    public static final int MAX_BURST = 1000;

    /** One in this many burst jobs is an `Error`, mirroring the ratio the page's own producer uses. */
    private static final int BURST_ERROR_EVERY = 10;

    /** The demo's job-id format. Single source of truth for both producers. */
    public static String newJobId() {
        return "JOB-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
    }

    /**
     * Produce {@code count} jobs in a single pipelined round trip, so a backlog exists before the workers
     * can drain it.
     *
     * <p>Why a burst exists at all: with the page's steady producer the queue never builds up (in
     * {@code FAST} even one worker keeps up with ~10 jobs/s), so the completion rate reflects the
     * <em>producer</em>, not the pool — adding workers changes nothing visible. Bursting N jobs and
     * watching the drain rate is what makes competing consumers legible.
     *
     * <p>Pipelined, not looped: {@value #MAX_BURST} sequential {@code XADD}s would spend as many round
     * trips, which would make the producer the bottleneck being measured.
     *
     * <p>Every {@value #BURST_ERROR_EVERY}th job is an `Error`, so the retry/DLQ path stays part of the demo.
     *
     * @return the message ids assigned by Redis, in production order
     * @throws IllegalArgumentException if {@code count} is outside 1..{@value #MAX_BURST}
     */
    public List<String> produceBurst(int count) {
        if (count < 1 || count > MAX_BURST) {
            throw new IllegalArgumentException(
                "Burst size must be between 1 and " + MAX_BURST + " (got " + count + ")");
        }

        try (var jedis = jedisPool.getResource()) {
            var pipeline = jedis.pipelined();
            List<redis.clients.jedis.Response<StreamEntryID>> queued = new ArrayList<>(count);
            // One timestamp for the whole burst: they really are created at the same instant.
            String createdAt = java.time.Instant.now().toString();

            for (int i = 1; i <= count; i++) {
                Map<String, String> payload = new HashMap<>();
                payload.put("jobId", newJobId());
                payload.put("processingType", i % BURST_ERROR_EVERY == 0 ? "Error" : "OK");
                payload.put("createdAt", createdAt);
                queued.add(pipeline.xadd(JOB_STREAM, XAddParams.xAddParams(), payload));
            }
            pipeline.sync();

            List<String> messageIds = queued.stream().map(r -> r.get().toString()).toList();
            log.info("Burst produced {} jobs ({} .. {})", count, messageIds.getFirst(), messageIds.getLast());
            return messageIds;
        }
    }

    /**
     * Produce a job to the job stream.
     */
    public String produceJob(String jobId, String processingType, Map<String, String> additionalFields) {
        try (var jedis = jedisPool.getResource()) {
            Map<String, String> payload = new HashMap<>();
            payload.put("jobId", jobId);
            payload.put("processingType", processingType);
            payload.put("createdAt", java.time.Instant.now().toString());
            if (additionalFields != null) {
                payload.putAll(additionalFields);
            }

            StreamEntryID messageId = jedis.xadd(JOB_STREAM, XAddParams.xAddParams(), payload);
            log.debug("Produced job {} with messageId {}", jobId, messageId);

            return messageId.toString();
        }
    }

    /**
     * Stop all workers.
     */
    /**
     * Stop all workers and wait for them to exit.
     *
     * <p>The join matters: a worker parked in its processing sleep would otherwise keep consuming from
     * the stream after this method returns (which also broke test isolation before it was added).
     */
    @PreDestroy
    public synchronized void stopWorkers() {
        log.info("Stopping all workers");
        shutdown.set(true);
        workers.values().forEach(handle -> handle.running().set(false));

        workers.values().forEach(handle -> {
            try {
                handle.thread().join(5000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            if (handle.thread().isAlive()) {
                log.warn("Worker thread {} did not stop within 5s", handle.thread().getName());
            }
        });
        workers.clear();
    }

    /** Number of workers currently running. */
    public int workerCount() {
        return workers.size();
    }

    /**
     * Add one worker to the pool. Worker ids stay contiguous, so the new worker is {@code count+1}
     * and it joins the consumer group implicitly on its first read (no {@code XGROUP CREATECONSUMER}).
     *
     * @return the new worker count
     * @throws IllegalStateException if the pool is already at {@link #MAX_WORKERS}
     */
    public synchronized int addWorker() {
        if (workerCount() >= MAX_WORKERS) {
            throw new IllegalStateException("Worker count is already at the maximum (" + MAX_WORKERS + ")");
        }
        spawnWorker(workerCount() + 1);
        return workerCount();
    }

    /**
     * Remove the highest-id worker.
     *
     * <p>Two flavors:
     * <ul>
     *   <li>{@code kill = false} — graceful: the loop exits at its next top-of-loop check, so an
     *       in-flight job is completed (copied to the done stream and {@code XACK}ed) first.</li>
     *   <li>{@code kill = true} — abrupt: the Virtual Thread is interrupted. If it was in its
     *       simulated processing sleep, {@code processMessage} returns without {@code XADD}/{@code XACK},
     *       so the job stays in the PEL and another worker reclaims it after {@code minIdleMs}
     *       (via {@code read_claim_or_dlq}). This is the crash-recovery demo.</li>
     * </ul>
     *
     * <p>The consumer is <strong>never</strong> deleted from the group: {@code XGROUP DELCONSUMER}
     * drops that consumer's pending entries, which would lose the in-flight job.
     *
     * @return the new worker count
     * @throws IllegalStateException if the pool is already at {@link #MIN_WORKERS}
     */
    public synchronized int removeWorker(boolean kill) {
        if (workerCount() <= MIN_WORKERS) {
            throw new IllegalStateException("Worker count is already at the minimum (" + MIN_WORKERS + ")");
        }

        int workerId = workerCount();
        WorkerHandle handle = workers.remove(workerId);
        handle.running().set(false);
        if (kill) {
            handle.thread().interrupt();
        }

        try {
            handle.thread().join(kill ? 1000 : 5000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        if (handle.thread().isAlive()) {
            log.warn("Worker-{} did not stop in time; it will exit on its next loop check", workerId);
        }

        // Monitoring of the done stream is deliberately left running: re-adding the worker is then a
        // no-op, and there is no stop/start race on the blocking XREAD.
        log.info("Removed worker-{} ({}); consumer kept in group '{}' so its pending entries stay claimable",
            workerId, kill ? "killed" : "graceful", JOB_GROUP);
        return workerCount();
    }

    /** The demo mode currently in force. */
    public DemoMode getDemoMode() {
        return demoMode;
    }

    /**
     * Switch the demo's pace. Takes effect on each worker's next loop iteration (no restart): the poll
     * interval and the simulated work time are read per iteration, and {@code minIdle} is passed to
     * {@code read_claim_or_dlq} on every call. A job already in flight finishes at the old work time.
     *
     * <p>Both timings move together on purpose — see the {@link DemoMode} invariant.
     *
     * @return the resulting timing state, as {@link #getDemoModeState()} reports it
     */
    public synchronized Map<String, Object> applyDemoMode(DemoMode mode) {
        demoMode = mode;
        processingSleepMs = mode.workMs();
        minIdleMs = mode.minIdleMs();
        pollIntervalMs = mode.pollMs();
        log.info("Demo mode set to {} (work={}ms, minIdle={}ms, poll={}ms, suggested producer sleep={}ms)",
            mode, mode.workMs(), mode.minIdleMs(), mode.pollMs(), mode.producerSleepMs());
        return getDemoModeState();
    }

    /**
     * Timing state for the UI: the active mode plus every mode it can offer, so the dropdown labels its
     * options with the backend's own numbers instead of duplicating them.
     *
     * <p>The reported timings are the <em>effective</em> ones, which is why they are read from the
     * fields rather than from the enum: an integration test may have overridden them.
     */
    public Map<String, Object> getDemoModeState() {
        Map<String, Object> state = new HashMap<>();
        state.put("mode", demoMode.name());
        state.put("label", demoMode.label());
        state.put("workMs", processingSleepMs);
        state.put("minIdleMs", minIdleMs);
        state.put("pollMs", pollIntervalMs);
        state.put("producerSleepMs", demoMode.producerSleepMs());
        state.put("burstSize", demoMode.burstSize());
        state.put("modes", Arrays.stream(DemoMode.values()).map(DemoMode::describe).toList());
        return state;
    }

    /** Worker pool state for the UI: current count and the bounds it can move between. */
    public Map<String, Object> getWorkerState() {
        Map<String, Object> state = new HashMap<>();
        state.put("count", workerCount());
        state.put("min", MIN_WORKERS);
        state.put("max", MAX_WORKERS);
        return state;
    }

    /** The consumer name a worker uses in the group. Single source of truth for worker naming. */
    public static String consumerName(int workerId) {
        return "worker-" + workerId;
    }

    /** Identity of a worker as the UI sees it: id, consumer name and done stream. */
    public static Map<String, Object> describeWorker(int workerId) {
        return Map.of(
            "id", workerId,
            "name", consumerName(workerId),
            "doneStream", JOB_DONE_PREFIX + workerId);
    }

    /** Descriptors of the running workers, ordered by worker id (1..count). */
    public List<Map<String, Object>> getConsumers() {
        return IntStream.rangeClosed(1, workerCount())
            .mapToObj(WorkQueueService::describeWorker)
            .toList();
    }

    /** Done stream names of the running workers, ordered by worker id (1..count). */
    private List<String> doneStreams() {
        return IntStream.rangeClosed(1, workerCount())
            .mapToObj(i -> JOB_DONE_PREFIX + i)
            .toList();
    }

    /**
     * Helper to convert Redis response to String.
     */
    private String convertToString(Object obj) {
        if (obj instanceof byte[]) {
            return new String((byte[]) obj);
        } else if (obj instanceof String) {
            return (String) obj;
        } else {
            return obj.toString();
        }
    }

    /**
     * Get stream names for this pattern. {@code doneStreams} is a list, not numbered keys, because
     * the worker count changes at runtime — the frontend renders one panel per entry.
     */
    public Map<String, Object> getStreamNames() {
        Map<String, Object> names = new HashMap<>();
        names.put("jobStream", JOB_STREAM);
        names.put("dlqStream", JOB_DLQ);
        names.put("group", JOB_GROUP);
        names.put("doneStreams", doneStreams());
        // Prefix as well as the list: the UI counts completions by matching the prefix, so a job finished
        // by a worker that was just removed (no longer in doneStreams) still counts.
        names.put("doneStreamPrefix", JOB_DONE_PREFIX);
        return names;
    }

    /**
     * Clear all work queue streams and recreate the consumer group.
     * This allows a clean restart without restarting the application.
     */
    public void clearAllStreams() {
        log.info("Clearing all work queue streams");

        try (var jedis = jedisPool.getResource()) {
            // Delete all streams
            List<String> streamsToDelete = new ArrayList<>();
            streamsToDelete.add(JOB_STREAM);
            streamsToDelete.add(JOB_DLQ);
            // 1..MAX_WORKERS, not 1..count: shrinking the pool must not leave orphan done streams.
            IntStream.rangeClosed(1, MAX_WORKERS).mapToObj(i -> JOB_DONE_PREFIX + i).forEach(streamsToDelete::add);

            for (String stream : streamsToDelete) {
                try {
                    jedis.del(stream);
                    log.debug("Deleted stream: {}", stream);
                } catch (Exception e) {
                    log.warn("Could not delete stream {}: {}", stream, e.getMessage());
                }
            }

            // Recreate consumer group
            initializeConsumerGroup();

            log.info("All work queue streams cleared and consumer group recreated");
        }
    }
}
