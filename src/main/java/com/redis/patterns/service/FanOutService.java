package com.redis.patterns.service;

import jakarta.annotation.PreDestroy;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.CommandLineRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Service;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.StreamEntryID;
import redis.clients.jedis.params.XAddParams;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Service implementing the Fan-Out (Broadcast) pattern with Redis Streams.
 * 
 * Key difference from Work Queue:
 * - Each worker has its OWN consumer group (fanout-group-1, fanout-group-2, etc.)
 * - Each message is delivered to ALL workers (broadcast)
 * - Still uses DLQ for failed messages after max retries
 */
@Slf4j
@Service
@RequiredArgsConstructor
@Order(2)  // Start after WorkQueueService
public class FanOutService implements CommandLineRunner {

    private final JedisPool jedisPool;
    private final RedisStreamListenerService streamListenerService;

    // Stream names
    public static final String FANOUT_STREAM = "fanout.events.v1";
    public static final String FANOUT_GROUP_PREFIX = "fanout-group-";
    public static final String FANOUT_DLQ = "fanout.events.v1:dlq";
    public static final String FANOUT_DONE_PREFIX = "fanout.done.worker-";

    // Configuration
    private static final int NUM_WORKERS = 4;
    private static final int MAX_DELIVERIES = 2;
    private static final long MIN_IDLE_MS = 100;
    private static final long POLL_INTERVAL_MS = 100;
    private static final long PROCESSING_SLEEP_MS = 100;

    // Lua function (same as WorkQueue)
    private static final String FUNCTION_NAME = "read_claim_or_dlq";

    // Worker management
    private final Map<Integer, AtomicBoolean> workerRunning = new ConcurrentHashMap<>();
    private final AtomicBoolean shutdown = new AtomicBoolean(false);

    @Override
    public void run(String... args) throws Exception {
        log.info("Starting Fan-Out Service with {} workers (each in own consumer group)", NUM_WORKERS);
        
        // Initialize consumer groups (one per worker)
        for (int i = 1; i <= NUM_WORKERS; i++) {
            initializeConsumerGroup(i);
        }
        
        // Start monitoring streams for WebSocket broadcasts
        streamListenerService.startMonitoring(FANOUT_STREAM);
        streamListenerService.startMonitoring(FANOUT_DLQ);
        for (int i = 1; i <= NUM_WORKERS; i++) {
            streamListenerService.startMonitoring(FANOUT_DONE_PREFIX + i);
        }
        
        // Start workers
        for (int i = 1; i <= NUM_WORKERS; i++) {
            startWorker(i);
        }
        
        log.info("Fan-Out Service started successfully");
    }

    /**
     * Initialize a consumer group for a specific worker.
     * Each worker has its own group to receive ALL messages (fan-out pattern).
     */
    private void initializeConsumerGroup(int workerId) {
        String groupName = FANOUT_GROUP_PREFIX + workerId;
        try (var jedis = jedisPool.getResource()) {
            try {
                jedis.xgroupCreate(FANOUT_STREAM, groupName, new StreamEntryID(), true);
                log.info("Consumer group '{}' created for stream '{}'", groupName, FANOUT_STREAM);
            } catch (Exception e) {
                if (e.getMessage() != null && e.getMessage().contains("BUSYGROUP")) {
                    log.info("Consumer group '{}' already exists", groupName);
                } else {
                    throw e;
                }
            }
        }
    }

    /**
     * Start a worker Virtual Thread.
     */
    private void startWorker(int workerId) {
        AtomicBoolean running = new AtomicBoolean(true);
        workerRunning.put(workerId, running);
        
        Thread.ofVirtual()
            .name("fanout-worker-" + workerId)
            .start(() -> workerLoop(workerId, running));
        
        log.info("Started fanout-worker-{} (group: {})", workerId, FANOUT_GROUP_PREFIX + workerId);
    }

    /**
     * Worker loop - polls for events and processes them.
     */
    private void workerLoop(int workerId, AtomicBoolean running) {
        String groupName = FANOUT_GROUP_PREFIX + workerId;
        String consumerName = "consumer-" + workerId;
        String doneStream = FANOUT_DONE_PREFIX + workerId;
        
        while (running.get() && !shutdown.get()) {
            try {
                processNextEvent(workerId, groupName, consumerName, doneStream);
                Thread.sleep(POLL_INTERVAL_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception e) {
                // Shutting down: Spring closes the JedisPool before these worker threads
                // notice, so the resulting pool error is expected, not a failure.
                if (shutdown.get()) break;
                log.error("FanOut-Worker-{} error: {}", workerId, e.getMessage());
                try {
                    Thread.sleep(1000);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }
        log.info("FanOut-Worker-{} stopped", workerId);
    }

    /**
     * Process the next available event.
     */
    private void processNextEvent(int workerId, String groupName, String consumerName, String doneStream) {
        try (var jedis = jedisPool.getResource()) {
            // Call read_claim_or_dlq Lua function with worker-specific group
            Object result = jedis.fcall(
                FUNCTION_NAME,
                Arrays.asList(FANOUT_STREAM, FANOUT_DLQ),
                Arrays.asList(groupName, consumerName, String.valueOf(MIN_IDLE_MS), "1", String.valueOf(MAX_DELIVERIES))
            );

            if (!(result instanceof List)) return;

            @SuppressWarnings("unchecked")
            List<Object> resultList = (List<Object>) result;
            if (resultList.size() < 2) return;

            // Process DLQ messages
            processDLQMessages(workerId, groupName, resultList.get(1));

            // Process messages to work on
            @SuppressWarnings("unchecked")
            List<Object> messages = (List<Object>) resultList.get(0);

            for (Object msgItem : messages) {
                processMessage(jedis, workerId, groupName, consumerName, doneStream, msgItem);
            }
        }
    }

    /**
     * Process DLQ messages - broadcast deletion events.
     */
    private void processDLQMessages(int workerId, String groupName, Object dlqResult) {
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
                    log.info("FanOut-Worker-{}: Event {} routed to DLQ with ID {}", workerId, originalId, dlqId);
                }
            }
        }
    }

    /**
     * Process a single message.
     */
    @SuppressWarnings("unchecked")
    private void processMessage(redis.clients.jedis.Jedis jedis, int workerId, String groupName,
                                String consumerName, String doneStream, Object msgItem) {
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
        String eventId = fields.getOrDefault("eventId", "unknown");

        log.debug("FanOut-Worker-{} processing event {} (type={})", workerId, eventId, processingType);

        try {
            Thread.sleep(PROCESSING_SLEEP_MS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return;
        }

        if ("OK".equals(processingType)) {
            // Success: copy to done stream and ACK.
            // At-least-once: XADD-done and XACK are not atomic. A crash between them re-delivers
            // the event (claimed via read_claim_or_dlq after MIN_IDLE_MS), producing a duplicate done
            // entry and possibly a DLQ route after MAX_DELIVERIES — downstream consumers must be idempotent.
            jedis.xadd(doneStream, XAddParams.xAddParams(), fields);
            jedis.xack(FANOUT_STREAM, groupName, new StreamEntryID(messageId));

            log.info("FanOut-Worker-{} completed event {} successfully", workerId, eventId);
        } else {
            // Error: do NOT acknowledge - will be retried or go to DLQ
            log.warn("FanOut-Worker-{} failed to process event {} (will retry)", workerId, eventId);
        }
    }

    /**
     * Produce an event to the fanout stream.
     */
    public String produceEvent(String eventId, String processingType, Map<String, String> additionalFields) {
        try (var jedis = jedisPool.getResource()) {
            Map<String, String> payload = new HashMap<>();
            payload.put("eventId", eventId);
            payload.put("processingType", processingType);
            payload.put("createdAt", java.time.Instant.now().toString());
            if (additionalFields != null) {
                payload.putAll(additionalFields);
            }

            StreamEntryID messageId = jedis.xadd(FANOUT_STREAM, XAddParams.xAddParams(), payload);
            log.debug("Produced event {} with messageId {}", eventId, messageId);

            return messageId.toString();
        }
    }

    /**
     * Stop all workers.
     */
    @PreDestroy
    public void stopWorkers() {
        log.info("Stopping all fan-out workers");
        shutdown.set(true);
        workerRunning.values().forEach(running -> running.set(false));
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
     * Get stream names for this pattern.
     */
    public Map<String, String> getStreamNames() {
        Map<String, String> names = new HashMap<>();
        names.put("eventStream", FANOUT_STREAM);
        names.put("dlqStream", FANOUT_DLQ);
        for (int i = 1; i <= NUM_WORKERS; i++) {
            names.put("doneStream" + i, FANOUT_DONE_PREFIX + i);
        }
        return names;
    }

    /**
     * Clear all fan-out streams and recreate consumer groups.
     */
    public void clearAllStreams() {
        log.info("Clearing all fan-out streams");

        try (var jedis = jedisPool.getResource()) {
            // Delete all streams
            List<String> streamsToDelete = new ArrayList<>();
            streamsToDelete.add(FANOUT_STREAM);
            streamsToDelete.add(FANOUT_DLQ);
            for (int i = 1; i <= NUM_WORKERS; i++) {
                streamsToDelete.add(FANOUT_DONE_PREFIX + i);
            }

            for (String stream : streamsToDelete) {
                try {
                    jedis.del(stream);
                    log.debug("Deleted stream: {}", stream);
                } catch (Exception e) {
                    log.warn("Could not delete stream {}: {}", stream, e.getMessage());
                }
            }

            // Recreate consumer groups (one per worker)
            for (int i = 1; i <= NUM_WORKERS; i++) {
                initializeConsumerGroup(i);
            }

            log.info("All fan-out streams cleared and consumer groups recreated");
        }
    }
}

