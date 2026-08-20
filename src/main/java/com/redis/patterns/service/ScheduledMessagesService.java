package com.redis.patterns.service;

import jakarta.annotation.PreDestroy;
import lombok.Data;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.CommandLineRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Service;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.params.XAddParams;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Service implementing the Scheduled/Delayed Messages pattern.
 * 
 * Uses a Sorted Set with score = execution timestamp to schedule messages.
 * A scheduler thread polls every 500ms to process due messages.
 * 
 * Redis structures:
 * - Sorted Set: scheduled.messages (score = epoch ms, value = message:<id>)
 * - Hash: scheduled:message:<id> (payload storage)
 * - Stream: reminders.v1 (executed messages)
 */
@Slf4j
@Service
@Order(6)
public class ScheduledMessagesService implements CommandLineRunner {

    private final JedisPool jedisPool;
    private final RedisStreamListenerService streamListenerService;

    // Redis keys
    public static final String SCHEDULED_SET = "scheduled.messages";
    public static final String MESSAGE_PREFIX = "scheduled:message:";
    public static final String REMINDERS_STREAM = "reminders.v1";

    // Scheduler config
    private static final long POLL_INTERVAL_MS = 500;
    private static final int BATCH_SIZE = 10;

    // Date formatter for stream display (yyyy-MM-dd HH:mm:ss)
    private static final DateTimeFormatter DATE_FORMATTER =
        DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss").withZone(ZoneId.systemDefault());

    private final AtomicBoolean running = new AtomicBoolean(false);
    private Thread schedulerThread;

    public ScheduledMessagesService(JedisPool jedisPool,
                                    RedisStreamListenerService streamListenerService) {
        this.jedisPool = jedisPool;
        this.streamListenerService = streamListenerService;
    }

    /**
     * Stops the scheduler before Spring closes the {@link JedisPool} it borrows from.
     */
    @PreDestroy
    void stopScheduler() {
        log.info("Stopping scheduled-messages scheduler");
        running.set(false);
        if (schedulerThread != null) {
            schedulerThread.interrupt();
        }
    }

    @Override
    public void run(String... args) throws Exception {
        log.info("=".repeat(60));
        log.info("STARTUP: Scheduled Messages Service");
        log.info("=".repeat(60));

        // Clear all at startup
        clearAll();
        log.info("✓ Cleared previous scheduled messages and reminders");

        // Start monitoring the reminders stream
        streamListenerService.startMonitoring(REMINDERS_STREAM);

        // Start the scheduler
        startScheduler();

        // Add example messages
        addExampleMessages();

        log.info("Scheduled Messages Service started");
        log.info("=".repeat(60));
    }

    /**
     * Start the scheduler thread that processes due messages.
     */
    public void startScheduler() {
        if (running.compareAndSet(false, true)) {
            schedulerThread = Thread.ofVirtual().name("scheduled-messages-scheduler").start(this::schedulerLoop);
            log.info("Scheduler started (polling every {}ms)", POLL_INTERVAL_MS);
        }
    }

    /**
     * Main scheduler loop - polls for due messages every POLL_INTERVAL_MS.
     */
    private void schedulerLoop() {
        while (running.get()) {
            try {
                processDueMessages();
                Thread.sleep(POLL_INTERVAL_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception e) {
                // Shutting down: Spring closes the JedisPool before this thread notices,
                // so the resulting pool error is expected, not a failure.
                if (!running.get()) break;
                log.error("Error in scheduler loop", e);
            }
        }
    }

    /**
     * Process all messages that are due (score <= now).
     */
    private void processDueMessages() {
        try (var jedis = jedisPool.getResource()) {
            long now = System.currentTimeMillis();
            
            // Get due messages: score between -inf and now
            List<String> dueMessages = jedis.zrangeByScore(SCHEDULED_SET, 0, now, 0, BATCH_SIZE);
            
            for (String messageKey : dueMessages) {
                try {
                    // Extract message ID from key (format: message:<id>)
                    String messageId = messageKey.replace("message:", "");
                    String hashKey = MESSAGE_PREFIX + messageId;
                    
                    // Get payload from hash
                    Map<String, String> payload = jedis.hgetAll(hashKey);
                    
                    if (!payload.isEmpty()) {
                        // Get scheduled timestamp. ZSCORE returns null if the member was
                        // removed concurrently (e.g. deleteMessage) between the ZRANGEBYSCORE
                        // above and here; skip it and clean up any orphaned hash.
                        Double score = jedis.zscore(SCHEDULED_SET, messageKey);
                        if (score == null) {
                            log.debug("Scheduled message {} was removed concurrently, skipping", messageId);
                            if (jedis.exists(hashKey)) {
                                jedis.del(hashKey);
                            }
                            continue;
                        }
                        long scheduledForMs = score.longValue();

                        // Add execution metadata with formatted timestamps
                        payload.put("executedAt", formatTimestamp(System.currentTimeMillis()));
                        payload.put("scheduledFor", formatTimestamp(scheduledForMs));

                        // Publish to reminders stream
                        Map<String, String> streamPayload = new HashMap<>(payload);
                        jedis.xadd(REMINDERS_STREAM, XAddParams.xAddParams(), streamPayload);
                        
                        log.debug("Executed scheduled message: {} -> {}", messageId, payload.get("title"));
                    }
                    
                    // Remove from sorted set and delete hash
                    jedis.zrem(SCHEDULED_SET, messageKey);
                    jedis.del(hashKey);
                    
                    // Notify WebSocket clients
                    notifyScheduledMessagesUpdate();
                    
                } catch (Exception e) {
                    log.error("Error processing message {}", messageKey, e);
                }
            }
        }
    }

    /**
     * Schedule a new message.
     */
    public ScheduledMessage scheduleMessage(String title, String description, long executeAtMs) {
        String id = UUID.randomUUID().toString().substring(0, 8);
        String messageKey = "message:" + id;
        String hashKey = MESSAGE_PREFIX + id;

        try (var jedis = jedisPool.getResource()) {
            // Store payload in hash
            Map<String, String> payload = new HashMap<>();
            payload.put("id", id);
            payload.put("title", title);
            payload.put("description", description);
            payload.put("scheduledFor", String.valueOf(executeAtMs));
            payload.put("createdAt", Instant.now().toString());
            jedis.hset(hashKey, payload);

            // Add to sorted set with score = execution time
            jedis.zadd(SCHEDULED_SET, executeAtMs, messageKey);

            log.info("Scheduled message '{}' for {}", title, Instant.ofEpochMilli(executeAtMs));
            notifyScheduledMessagesUpdate();

            return new ScheduledMessage(id, title, description, executeAtMs, Instant.now().toEpochMilli());
        }
    }

    /**
     * Update an existing scheduled message.
     */
    public ScheduledMessage updateMessage(String id, String title, String description, long executeAtMs) {
        String messageKey = "message:" + id;
        String hashKey = MESSAGE_PREFIX + id;

        try (var jedis = jedisPool.getResource()) {
            // Check if message exists
            if (!jedis.exists(hashKey)) {
                throw new IllegalArgumentException("Message not found: " + id);
            }

            // Update hash
            Map<String, String> payload = new HashMap<>();
            payload.put("id", id);
            payload.put("title", title);
            payload.put("description", description);
            payload.put("scheduledFor", String.valueOf(executeAtMs));
            payload.put("updatedAt", Instant.now().toString());
            jedis.hset(hashKey, payload);

            // Update score in sorted set
            jedis.zadd(SCHEDULED_SET, executeAtMs, messageKey);

            log.info("Updated message '{}' - new time: {}", title, Instant.ofEpochMilli(executeAtMs));
            notifyScheduledMessagesUpdate();

            return new ScheduledMessage(id, title, description, executeAtMs, Instant.now().toEpochMilli());
        }
    }

    /**
     * Delete a scheduled message.
     */
    public void deleteMessage(String id) {
        String messageKey = "message:" + id;
        String hashKey = MESSAGE_PREFIX + id;

        try (var jedis = jedisPool.getResource()) {
            jedis.zrem(SCHEDULED_SET, messageKey);
            jedis.del(hashKey);
            log.info("Deleted scheduled message: {}", id);
            notifyScheduledMessagesUpdate();
        }
    }

    /**
     * Get all scheduled messages.
     */
    public List<ScheduledMessage> getAllScheduledMessages() {
        List<ScheduledMessage> messages = new ArrayList<>();

        try (var jedis = jedisPool.getResource()) {
            // Get all from sorted set with scores
            List<redis.clients.jedis.resps.Tuple> entries = jedis.zrangeWithScores(SCHEDULED_SET, 0, -1);

            for (var entry : entries) {
                String messageKey = entry.getElement();
                String id = messageKey.replace("message:", "");
                String hashKey = MESSAGE_PREFIX + id;

                Map<String, String> payload = jedis.hgetAll(hashKey);
                if (!payload.isEmpty()) {
                    messages.add(new ScheduledMessage(
                        id,
                        payload.getOrDefault("title", ""),
                        payload.getOrDefault("description", ""),
                        (long) entry.getScore(),
                        payload.containsKey("createdAt") ?
                            Instant.parse(payload.get("createdAt")).toEpochMilli() : 0
                    ));
                }
            }
        }

        // Sort by scheduled time
        messages.sort(Comparator.comparingLong(ScheduledMessage::getScheduledFor));
        return messages;
    }

    /**
     * Clear all scheduled messages and reminders stream.
     */
    public void clearAll() {
        log.info("Clearing all scheduled messages");

        try (var jedis = jedisPool.getResource()) {
            // Get all message keys to delete hashes
            List<String> messageKeys = jedis.zrange(SCHEDULED_SET, 0, -1);
            for (String key : messageKeys) {
                String id = key.replace("message:", "");
                jedis.del(MESSAGE_PREFIX + id);
            }

            // Delete sorted set
            jedis.del(SCHEDULED_SET);

            // Delete reminders stream
            jedis.del(REMINDERS_STREAM);

            log.info("Cleared {} scheduled messages and reminders stream", messageKeys.size());
            notifyScheduledMessagesUpdate();
        }
    }

    /**
     * Add example messages at startup.
     */
    private void addExampleMessages() {
        long now = System.currentTimeMillis();

        scheduleMessage("Payment reminder", "Send payment reminder to customer #1234", now + 5 * 60 * 1000);
        scheduleMessage("Order expiration", "Cancel unpaid order #5678", now + 7 * 60 * 1000);
        scheduleMessage("Welcome email", "Send welcome email to new user", now + 10 * 60 * 1000);

        log.info("Added 3 example scheduled messages (5, 7, 10 minutes from now)");
    }

    /**
     * Placeholder for future WebSocket notification.
     * Currently, Angular polls the API to refresh the list.
     */
    private void notifyScheduledMessagesUpdate() {
        // Angular polls the API to refresh the scheduled messages list
    }

    /**
     * Get stream names for this pattern.
     */
    public Map<String, String> getStreamNames() {
        Map<String, String> names = new HashMap<>();
        names.put("remindersStream", REMINDERS_STREAM);
        names.put("scheduledSet", SCHEDULED_SET);
        return names;
    }

    /**
     * Format epoch milliseconds to readable date/time string.
     */
    private String formatTimestamp(long epochMs) {
        return DATE_FORMATTER.format(Instant.ofEpochMilli(epochMs));
    }

    // DTO
    @Data
    public static class ScheduledMessage {
        private final String id;
        private final String title;
        private final String description;
        private final long scheduledFor;
        private final long createdAt;
    }
}

