package com.redis.patterns.service;

import com.redis.patterns.dto.DLQEvent;
import com.redis.patterns.dto.PerKeySlotEvent;
import jakarta.annotation.PreDestroy;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.CommandLineRunner;
import org.springframework.stereotype.Service;
import redis.clients.jedis.Jedis;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.StreamEntryID;
import redis.clients.jedis.params.XAddParams;
import redis.clients.jedis.params.XAutoClaimParams;
import redis.clients.jedis.params.XReadGroupParams;
import redis.clients.jedis.resps.StreamEntry;

import java.time.Instant;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Service implementing the Per-Key Serialized Processing pattern.
 * 
 * Jobs for the same business key (orderId) are processed sequentially,
 * while different keys can run in parallel across workers.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class PerKeySerializedService implements CommandLineRunner {

    private final JedisPool jedisPool;
    private final WebSocketEventService webSocketEventService;
    private final RedisStreamListenerService streamListenerService;

    // Stream names
    public static final String JOB_STREAM = "jobs.perkey.v1";
    public static final String JOB_GROUP = "jobs-serialized-group";
    public static final String WORKER_DONE_PREFIX = "jobs.perkey.v1.worker";
    private static final String LOCK_PREFIX = "running:order:";

    // Configuration
    private static final int NUM_WORKERS = 3;
    private static final long POLL_INTERVAL_MS = 500;
    private static final long PROCESSING_SLEEP_MS = 4000;
    private static final long LOCK_TTL_MS = 30000; // 30 seconds lock TTL
    // Reclaim idle must exceed processing time, otherwise an in-flight message
    // gets reclaimed repeatedly while a worker is still processing it.
    private static final long RECLAIM_MIN_IDLE_MS = 10000;

    // Worker management
    private final Map<Integer, AtomicBoolean> workerRunning = new ConcurrentHashMap<>();
    private final AtomicBoolean shutdown = new AtomicBoolean(false);

    /**
     * Stops the workers before Spring closes the {@link JedisPool} they borrow from.
     * Without this the loops kept polling a closed pool and logged spurious errors.
     */
    @PreDestroy
    void stopWorkers() {
        log.info("Stopping per-key workers");
        shutdown.set(true);
        workerRunning.values().forEach(flag -> flag.set(false));
    }

    @Override
    public void run(String... args) {
        try {
            log.info("Starting Per-Key Serialized Service with {} workers", NUM_WORKERS);

            clearAllStreams();
            initializeConsumerGroup();

            // Start monitoring streams for WebSocket broadcasts
            streamListenerService.startMonitoring(JOB_STREAM);
            for (int i = 1; i <= NUM_WORKERS; i++) {
                streamListenerService.startMonitoring(WORKER_DONE_PREFIX + i + ".done");
            }

            // Start workers
            for (int i = 1; i <= NUM_WORKERS; i++) {
                startWorker(i);
            }

            log.info("Per-Key Serialized Service started successfully");
        } catch (Exception e) {
            log.error("Failed to start Per-Key Serialized Service: {}", e.getMessage(), e);
        }
    }

    private void initializeConsumerGroup() {
        try (var jedis = jedisPool.getResource()) {
            try {
                jedis.xgroupCreate(JOB_STREAM, JOB_GROUP, new StreamEntryID(), true);
                log.info("Consumer group '{}' created for stream '{}'", JOB_GROUP, JOB_STREAM);
            } catch (Exception e) {
                if (e.getMessage() != null && e.getMessage().contains("BUSYGROUP")) {
                    log.info("Consumer group '{}' already exists", JOB_GROUP);
                } else {
                    throw e;
                }
            }
        }
    }

    private void startWorker(int workerId) {
        AtomicBoolean running = new AtomicBoolean(true);
        workerRunning.put(workerId, running);
        
        Thread.ofVirtual()
            .name("per-key-worker-" + workerId)
            .start(() -> workerLoop(workerId, running));
        
        log.info("Started per-key worker-{}", workerId);
    }

    private void workerLoop(int workerId, AtomicBoolean running) {
        String consumerName = "worker-" + workerId;
        String doneStream = WORKER_DONE_PREFIX + workerId + ".done";
        
        while (running.get() && !shutdown.get()) {
            try {
                processNextJob(workerId, consumerName, doneStream);
                Thread.sleep(POLL_INTERVAL_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception e) {
                // Shutting down: Spring closes the JedisPool before these worker threads
                // notice, so the resulting pool error is expected, not a failure.
                if (shutdown.get()) break;
                log.error("Per-key worker-{} error: {}", workerId, e.getMessage());
                try { Thread.sleep(1000); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); break; }
            }
        }
        log.info("Per-key worker-{} stopped", workerId);
    }
    
    private void processNextJob(int workerId, String consumerName, String doneStream) {
        try (var jedis = jedisPool.getResource()) {
            // First, try to claim and process idle pending messages (from any consumer)
            claimAndProcessIdleMessages(workerId, consumerName, doneStream, jedis);

            // Then read new messages
            var params = XReadGroupParams.xReadGroupParams().count(1).block(100);
            var results = jedis.xreadGroup(JOB_GROUP, consumerName, params,
                Map.of(JOB_STREAM, StreamEntryID.XREADGROUP_UNDELIVERED_ENTRY));

            if (results == null || results.isEmpty()) return;

            for (var streamMessages : results) {
                for (StreamEntry entry : streamMessages.getValue()) {
                    processEntry(workerId, consumerName, doneStream, entry, jedis);
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private void claimAndProcessIdleMessages(int workerId, String consumerName, String doneStream, Jedis jedis)
            throws InterruptedException {
        // Claim messages idle longer than the processing time, so we never reclaim
        // a message another worker is still actively processing.
        var claimResult = jedis.xautoclaim(JOB_STREAM, JOB_GROUP, consumerName,
            RECLAIM_MIN_IDLE_MS, new StreamEntryID("0-0"), new XAutoClaimParams().count(1));

        if (claimResult != null && claimResult.getValue() != null) {
            for (StreamEntry entry : claimResult.getValue()) {
                log.info("Worker-{}: Claimed idle message {} for orderId={}, action={}",
                    workerId, entry.getID(), entry.getFields().get("orderId"), entry.getFields().get("action"));
                processEntry(workerId, consumerName, doneStream, entry, jedis);
            }
        }
    }

    private void processEntry(int workerId, String consumerName, String doneStream, StreamEntry entry, Jedis jedis)
            throws InterruptedException {
        String messageId = entry.getID().toString();
        Map<String, String> fields = entry.getFields();
        String orderId = fields.get("orderId");
        String action = fields.get("action");
        String lockKey = LOCK_PREFIX + orderId;

        // Try to acquire lock (non-blocking)
        String lockResult = jedis.set(lockKey, messageId,
            redis.clients.jedis.params.SetParams.setParams().nx().px(LOCK_TTL_MS));

        if (lockResult == null) {
            // Lock exists - another worker is processing this orderId
            // Don't wait! Leave message pending, it will be claimed later via XAUTOCLAIM
            log.info("Worker-{}: orderId={} is LOCKED, skipping action={} (will retry later)",
                workerId, orderId, action);

            // The refusal is the pattern working, so the UI is told about it: a log line only was
            // invisible to the very people the demo is for.
            webSocketEventService.broadcastEvent(PerKeySlotEvent.builder()
                .phase(PerKeySlotEvent.Phase.LOCK_SKIPPED)
                .workerId(workerId).orderId(orderId).action(action)
                .messageId(messageId).atMs(System.currentTimeMillis())
                .build());
            return;
        }

        try {
            log.info("Worker-{}: PROCESSING orderId={}, action={} (messageId={})",
                workerId, orderId, action, messageId);

            // Emitted BEFORE the sleep: a job that only shows up once it is over cannot show
            // occupancy, which is the whole point of the time-slot grid.
            webSocketEventService.broadcastEvent(PerKeySlotEvent.builder()
                .phase(PerKeySlotEvent.Phase.STARTED)
                .workerId(workerId).orderId(orderId).action(action)
                .messageId(messageId).atMs(System.currentTimeMillis())
                .build());

            // Simulate processing
            Thread.sleep(PROCESSING_SLEEP_MS);

            // Copy to done stream - orderId first, then action
            Map<String, String> doneFields = new LinkedHashMap<>();
            doneFields.put("orderId", orderId);
            doneFields.put("action", action);
            doneFields.put("processedBy", "worker-" + workerId);
            doneFields.put("processedAt", Instant.now().toString());

            jedis.xadd(doneStream, XAddParams.xAddParams(), doneFields);

            webSocketEventService.broadcastEvent(PerKeySlotEvent.builder()
                .phase(PerKeySlotEvent.Phase.FINISHED)
                .workerId(workerId).orderId(orderId).action(action)
                .messageId(messageId).atMs(System.currentTimeMillis())
                .build());

            // ACK the message
            jedis.xack(JOB_STREAM, JOB_GROUP, new StreamEntryID(messageId));

            // Tell the UI it was acked — the entry stays in the stream
            webSocketEventService.broadcastEvent(DLQEvent.builder()
                .eventType(DLQEvent.EventType.MESSAGE_ACKED)
                .messageId(messageId)
                .streamName(JOB_STREAM)
                .details("Processed by worker-" + workerId)
                .build());

            log.info("Worker-{}: COMPLETED orderId={}, action={}", workerId, orderId, action);
        } finally {
            // Release the lock via the registered compare-and-delete function: it only
            // deletes the lock if it still holds OUR token (messageId). A plain DEL could
            // erase a lock another worker re-acquired after our TTL expired.
            jedis.fcall("release_lock",
                Collections.singletonList(lockKey), Collections.singletonList(messageId));
            log.debug("Worker-{}: Released lock for orderId={}", workerId, orderId);
        }
    }

    public Map<String, Object> submitJobs(List<Map<String, String>> jobs) {
        int submitted = 0;
        try (var jedis = jedisPool.getResource()) {
            for (Map<String, String> job : jobs) {
                Map<String, String> fields = new LinkedHashMap<>();
                fields.put("orderId", job.get("orderId"));
                fields.put("action", job.get("action"));
                fields.put("createdAt", Instant.now().toString());

                jedis.xadd(JOB_STREAM, XAddParams.xAddParams(), fields);
                submitted++;
            }
        }
        log.info("Submitted {} jobs to {}", submitted, JOB_STREAM);
        return Map.of("success", true, "jobsSubmitted", submitted);
    }

    public void clearAllStreams() {
        log.info("Clearing all per-key serialized streams");
        try (var jedis = jedisPool.getResource()) {
            // Delete streams
            jedis.del(JOB_STREAM);
            for (int i = 1; i <= NUM_WORKERS; i++) {
                jedis.del(WORKER_DONE_PREFIX + i + ".done");
            }
            // Delete any locks
            var lockKeys = jedis.keys(LOCK_PREFIX + "*");
            if (lockKeys != null && !lockKeys.isEmpty()) {
                jedis.del(lockKeys.toArray(new String[0]));
            }
            // Recreate consumer group
            initializeConsumerGroup();
            log.info("All per-key serialized streams cleared");
        }
    }
}

