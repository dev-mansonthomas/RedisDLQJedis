package com.redis.patterns.service;

import com.redis.patterns.dto.DLQEvent;
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
 * Service implementing the Token Bucket pattern for dynamic concurrency control.
 * 
 * Limits global concurrency per job type (payment, email, csv) to protect external systems.
 * Uses atomic Lua script to acquire token + read message atomically.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class TokenBucketService implements CommandLineRunner {

    private final JedisPool jedisPool;
    private final WebSocketEventService webSocketEventService;
    private final RedisStreamListenerService streamListenerService;

    // Stream names - explicit for this use case
    public static final String JOB_STREAM = "token-bucket.jobs.v1";
    public static final String JOB_GROUP = "token-bucket-group";
    public static final String DONE_STREAM = "token-bucket.jobs.v1.done";
    public static final String PROGRESS_STREAM = "token-bucket.jobs.v1.progress";

    // Redis keys for concurrency control
    private static final String RUNNING_PREFIX = "token-bucket:running:";
    private static final String COMPLETED_PREFIX = "token-bucket:completed:";
    private static final String CONFIG_KEY = "token-bucket:config";

    // Log lists for submissions and completions
    private static final String SUBMIT_LOG = "token-bucket:log:submitted";
    private static final String COMPLETE_LOG = "token-bucket:log:completed";
    
    // Job types with their limits and processing times
    public enum JobType {
        PAYMENT("payment", 3, 4000L),   // Max 3 concurrent, 4s each
        EMAIL("email", 2, 4000L),       // Max 2 concurrent, 4s each
        CSV("csv", 1, 10000L);          // Max 1 concurrent, 10s each
        
        public final String name;
        public final int defaultMaxConcurrency;
        public final long processingTimeMs;
        
        JobType(String name, int defaultMaxConcurrency, long processingTimeMs) {
            this.name = name;
            this.defaultMaxConcurrency = defaultMaxConcurrency;
            this.processingTimeMs = processingTimeMs;
        }
    }

    // Configuration
    // 3 job types x max 6 concurrent = 18 workers needed to saturate all limits
    private static final int NUM_WORKERS = 18;
    private static final long POLL_INTERVAL_MS = 10; // Fast polling for responsiveness
    // XAUTOCLAIM idle threshold for reclaiming pending messages. MUST exceed the maximum
    // processing time (longest job is CSV at 10s) — otherwise an in-flight message held by a
    // busy (not dead) worker gets stolen by another worker and processed twice, breaking the
    // concurrency cap this pattern exists to enforce. 15s leaves margin over the 10s job.
    private static final long RECLAIM_MIN_IDLE_MS = 15000;

    // Worker management
    private final Map<Integer, AtomicBoolean> workerRunning = new ConcurrentHashMap<>();
    private final AtomicBoolean shutdown = new AtomicBoolean(false);

    // Token acquire/release run as registered functions in the stream_utils Lua
    // library (see lua/stream_utils.lua), invoked via FCALL — consistent with the
    // other patterns and loaded once at startup by RedisLuaFunctionLoader.
    private static final String ACQUIRE_TOKEN_FUNCTION = "acquire_token";
    private static final String RELEASE_TOKEN_FUNCTION = "release_token";

    /**
     * Stops the workers before Spring closes the {@link JedisPool} they borrow from.
     */
    @PreDestroy
    void stopWorkers() {
        log.info("Stopping token bucket workers");
        shutdown.set(true);
        workerRunning.values().forEach(flag -> flag.set(false));
    }

    @Override
    public void run(String... args) throws Exception {
        initializeRedisStructures();
        startWorkers();
    }

    private void initializeRedisStructures() {
        try (var jedis = jedisPool.getResource()) {
            // Create consumer group if not exists
            try {
                jedis.xgroupCreate(JOB_STREAM, JOB_GROUP, StreamEntryID.LAST_ENTRY, true);
                log.info("Created consumer group {} for stream {}", JOB_GROUP, JOB_STREAM);
            } catch (Exception e) {
                if (e.getMessage() == null || !e.getMessage().contains("BUSYGROUP")) {
                    log.warn("Error creating consumer group: {}", e.getMessage());
                }
            }

            // Initialize default config
            for (JobType type : JobType.values()) {
                String configField = "max:" + type.name;
                if (jedis.hget(CONFIG_KEY, configField) == null) {
                    jedis.hset(CONFIG_KEY, configField, String.valueOf(type.defaultMaxConcurrency));
                }
            }

            // Start monitoring streams for WebSocket
            streamListenerService.startMonitoring(JOB_STREAM);
            streamListenerService.startMonitoring(DONE_STREAM);
            
            log.info("Token Bucket Service initialized with streams: {}, {}", JOB_STREAM, DONE_STREAM);
        }
    }

    private void startWorkers() {
        for (int i = 1; i <= NUM_WORKERS; i++) {
            final int workerId = i;
            workerRunning.put(workerId, new AtomicBoolean(true));
            
            Thread.ofVirtual().name("token-bucket-worker-" + workerId).start(() -> {
                log.info("Token Bucket Worker-{} started", workerId);
                while (!shutdown.get() && workerRunning.get(workerId).get()) {
                    try {
                        processNextJob(workerId);
                        Thread.sleep(POLL_INTERVAL_MS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        break;
                    } catch (Exception e) {
                        // Shutting down: Spring closes the JedisPool before these worker
                        // threads notice, so the pool error is expected, not a failure.
                        if (shutdown.get()) break;
                        log.error("Worker-{} error: {}", workerId, e.getMessage(), e);
                    }
                }
                log.info("Token Bucket Worker-{} stopped", workerId);
            });
        }
    }

    private void processNextJob(int workerId) throws InterruptedException {
        try (var jedis = jedisPool.getResource()) {
            String consumerName = "worker-" + workerId;

            // First, try to claim idle messages (skipped by other workers)
            var claimParams = XAutoClaimParams.xAutoClaimParams().count(1);
            var claimResult = jedis.xautoclaim(JOB_STREAM, JOB_GROUP, consumerName,
                RECLAIM_MIN_IDLE_MS, new StreamEntryID("0-0"), claimParams); // idle threshold must exceed max job time

            if (claimResult != null && !claimResult.getValue().isEmpty()) {
                for (StreamEntry entry : claimResult.getValue()) {
                    processEntry(workerId, consumerName, entry, jedis);
                }
                return;
            }

            // Then, read new messages
            var params = XReadGroupParams.xReadGroupParams().count(1).block(50);
            var results = jedis.xreadGroup(JOB_GROUP, consumerName, params,
                Map.of(JOB_STREAM, StreamEntryID.XREADGROUP_UNDELIVERED_ENTRY));

            if (results == null || results.isEmpty()) return;

            for (var streamMessages : results) {
                for (StreamEntry entry : streamMessages.getValue()) {
                    processEntry(workerId, consumerName, entry, jedis);
                }
            }
        }
    }

    private void processEntry(int workerId, String consumerName, StreamEntry entry, Jedis jedis)
            throws InterruptedException {
        String messageId = entry.getID().toString();
        Map<String, String> fields = entry.getFields();
        String jobType = fields.get("type");
        String jobId = fields.get("jobId");
        String runningKey = RUNNING_PREFIX + jobType;

        // Get max concurrency for this job type
        int maxConcurrency = getMaxConcurrency(jobType, jedis);

        // Try to acquire a token via the registered Lua function (atomic check-and-incr)
        Object result = jedis.fcall(ACQUIRE_TOKEN_FUNCTION,
            List.of(runningKey),
            List.of(String.valueOf(maxConcurrency)));

        if (Long.valueOf(0).equals(result)) {
            // No token available - skip this message, will retry later
            log.info("Worker-{}: {} concurrency FULL ({}/{}), skipping jobId={}",
                workerId, jobType.toUpperCase(), getCurrentRunning(jobType, jedis), maxConcurrency, jobId);
            return;
        }

        try {
            int currentRunning = getCurrentRunning(jobType, jedis);
            log.info("Worker-{}: PROCESSING {} jobId={} ({}/{} concurrent)",
                workerId, jobType.toUpperCase(), jobId, currentRunning, maxConcurrency);

            // Publish START progress event
            publishProgress(jedis, jobType, jobId, "STARTED", workerId);

            // Get processing time for this job type
            long processingTime = getProcessingTime(jobType);
            Thread.sleep(processingTime);

            // Publish COMPLETED progress event
            publishProgress(jedis, jobType, jobId, "COMPLETED", workerId);

            // Write to done stream
            Map<String, String> doneFields = new LinkedHashMap<>();
            doneFields.put("type", jobType);
            doneFields.put("jobId", jobId);
            doneFields.put("processedBy", "worker-" + workerId);
            doneFields.put("processedAt", Instant.now().toString());
            doneFields.put("duration", processingTime + "ms");

            // At-least-once: XADD-done then XACK are NOT atomic. A crash between them re-delivers
            // the message (XAUTOCLAIM after RECLAIM_MIN_IDLE_MS), producing a duplicate done entry
            // and possibly a DLQ route after MAX_DELIVERIES — downstream consumers must be idempotent.
            jedis.xadd(DONE_STREAM, XAddParams.xAddParams(), doneFields);

            // Increment completed counter for this job type
            jedis.incr(COMPLETED_PREFIX + jobType);

            // Add to completion log
            String logEntry = String.format("[%s] %s %s completed by worker-%d",
                Instant.now().toString().substring(11, 19), jobType.toUpperCase(), shortJobId(jobId), workerId);
            jedis.lpush(COMPLETE_LOG, logEntry);
            jedis.ltrim(COMPLETE_LOG, 0, 99); // Keep last 100 entries

            // ACK the message
            jedis.xack(JOB_STREAM, JOB_GROUP, new StreamEntryID(messageId));

            // Tell the UI it was acked — the entry stays in the stream
            webSocketEventService.broadcastEvent(DLQEvent.builder()
                .eventType(DLQEvent.EventType.MESSAGE_ACKED)
                .messageId(messageId)
                .streamName(JOB_STREAM)
                .details("Processed by worker-" + workerId)
                .build());

            log.info("Worker-{}: COMPLETED {} jobId={}", workerId, jobType.toUpperCase(), jobId);
        } finally {
            // Release the token via the registered Lua function (decrement floored at 0,
            // so a redelivery-driven double release can't drive the counter negative)
            jedis.fcall(RELEASE_TOKEN_FUNCTION, List.of(runningKey), List.of());
            log.debug("Worker-{}: Released token for {}", workerId, jobType);
        }
    }

    private int getMaxConcurrency(String jobType, Jedis jedis) {
        String value = jedis.hget(CONFIG_KEY, "max:" + jobType);
        if (value != null) {
            return Integer.parseInt(value);
        }
        // Return default from enum
        for (JobType type : JobType.values()) {
            if (type.name.equals(jobType)) {
                return type.defaultMaxConcurrency;
            }
        }
        return 1;
    }

    private int getCurrentRunning(String jobType, Jedis jedis) {
        String value = jedis.get(RUNNING_PREFIX + jobType);
        return value != null ? Integer.parseInt(value) : 0;
    }

    private long getProcessingTime(String jobType) {
        for (JobType type : JobType.values()) {
            if (type.name.equals(jobType)) {
                return type.processingTimeMs;
            }
        }
        return 4000L;
    }

    private void publishProgress(Jedis jedis, String jobType, String jobId, String status, int workerId) {
        Map<String, String> progressFields = new LinkedHashMap<>();
        progressFields.put("type", jobType);
        progressFields.put("jobId", jobId);
        progressFields.put("status", status);
        progressFields.put("workerId", String.valueOf(workerId));
        progressFields.put("timestamp", Instant.now().toString());
        jedis.xadd(PROGRESS_STREAM, XAddParams.xAddParams().maxLen(1000), progressFields);
    }

    private String shortJobId(String jobId) {
        // Extract the unique part (last segment after type prefix)
        int lastDash = jobId.lastIndexOf('-');
        if (lastDash > 0) {
            return "#" + jobId.substring(lastDash + 1);
        }
        return jobId;
    }

    public Map<String, Object> submitJobs(String jobType, int count) {
        int submitted = 0;
        try (var jedis = jedisPool.getResource()) {
            long baseTimestamp = System.currentTimeMillis();
            for (int i = 1; i <= count; i++) {
                String jobId = jobType + "-" + baseTimestamp + "-" + i;
                Map<String, String> fields = new LinkedHashMap<>();
                fields.put("type", jobType);
                fields.put("jobId", jobId);
                fields.put("submittedAt", Instant.now().toString());

                jedis.xadd(JOB_STREAM, XAddParams.xAddParams(), fields);

                // Add to submission log
                String logEntry = String.format("[%s] %s %s submitted",
                    Instant.now().toString().substring(11, 19), jobType.toUpperCase(), shortJobId(jobId));
                jedis.lpush(SUBMIT_LOG, logEntry);
                jedis.ltrim(SUBMIT_LOG, 0, 99); // Keep last 100 entries

                submitted++;
            }
        }
        log.info("Submitted {} {} jobs", submitted, jobType);
        return Map.of("submitted", submitted, "type", jobType);
    }

    public Map<String, Object> getConfig() {
        Map<String, Object> config = new HashMap<>();
        try (var jedis = jedisPool.getResource()) {
            for (JobType type : JobType.values()) {
                config.put(type.name + "_max", getMaxConcurrency(type.name, jedis));
                config.put(type.name + "_running", getCurrentRunning(type.name, jedis));
            }
        }
        return config;
    }

    public Map<String, Object> updateConfig(String jobType, int maxConcurrency) {
        try (var jedis = jedisPool.getResource()) {
            jedis.hset(CONFIG_KEY, "max:" + jobType, String.valueOf(maxConcurrency));
            log.info("Updated {} max concurrency to {}", jobType, maxConcurrency);
        }
        return Map.of("type", jobType, "maxConcurrency", maxConcurrency);
    }

    public void clearAllStreams() {
        try (var jedis = jedisPool.getResource()) {
            jedis.del(JOB_STREAM, DONE_STREAM, PROGRESS_STREAM, SUBMIT_LOG, COMPLETE_LOG);
            // Reset running and completed counters
            for (JobType type : JobType.values()) {
                jedis.del(RUNNING_PREFIX + type.name);
                jedis.del(COMPLETED_PREFIX + type.name);
            }
            // Recreate consumer group
            try {
                jedis.xgroupCreate(JOB_STREAM, JOB_GROUP, StreamEntryID.LAST_ENTRY, true);
            } catch (Exception e) {
                if (e.getMessage() == null || !e.getMessage().contains("BUSYGROUP")) {
                    log.warn("Error recreating consumer group: {}", e.getMessage());
                }
            }

            // Re-start monitoring (this re-registers the streams)
            streamListenerService.startMonitoring(JOB_STREAM);
            streamListenerService.startMonitoring(DONE_STREAM);

            log.info("Cleared all Token Bucket streams and counters");
        }
    }

    public Map<String, Object> getLogs() {
        Map<String, Object> result = new HashMap<>();
        try (var jedis = jedisPool.getResource()) {
            List<String> submitLogs = jedis.lrange(SUBMIT_LOG, 0, 49);
            List<String> completeLogs = jedis.lrange(COMPLETE_LOG, 0, 49);
            result.put("submitted", submitLogs);
            result.put("completed", completeLogs);
        }
        return result;
    }

    public Map<String, Object> getProgress() {
        Map<String, Object> result = new HashMap<>();
        try (var jedis = jedisPool.getResource()) {
            // Get current running counts per type
            for (JobType type : JobType.values()) {
                result.put(type.name, getCurrentRunning(type.name, jedis));
                // Also return completed counts
                String completedValue = jedis.get(COMPLETED_PREFIX + type.name);
                result.put(type.name + "_completed", completedValue != null ? Integer.parseInt(completedValue) : 0);
            }
        }
        return result;
    }
}
