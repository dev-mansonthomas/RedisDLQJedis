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

import java.time.Instant;
import java.util.*;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Service implementing the Content-Based Routing pattern.
 * Routes payment messages based on their content (amount) to different streams.
 *
 * Routing rules based on amount:
 *   amount < 0       -> ERROR (goes to DLQ after max deliveries)
 *   0 <= amount < 100 -> payments.standard.v1 (OK, low value)
 *   100 <= amount < 10000 -> payments.highRisk.v1 (needs review)
 *   amount >= 10000  -> payments.manualReview.v1 (high value, human review)
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ContentBasedRoutingService implements CommandLineRunner {

    private final JedisPool jedisPool;
    private final WebSocketEventService webSocketEventService;
    private final RedisStreamListenerService streamListenerService;

    // Stream names
    public static final String INCOMING_STREAM = "payments.incoming.v1";
    public static final String HIGH_RISK_STREAM = "payments.highRisk.v1";
    public static final String STANDARD_STREAM = "payments.standard.v1";
    public static final String MANUAL_REVIEW_STREAM = "payments.manualReview.v1";
    public static final String DLQ_STREAM = "payments.incoming.v1:dlq";
    public static final String CONSUMER_GROUP = "payments-router-group";

    // Configuration
    private static final int MAX_DELIVERIES = 2;
    private static final long MIN_IDLE_MS = 100;
    private static final long POLL_INTERVAL_MS = 500;  // 500ms polling
    private static final long ROUTER_STARTUP_DELAY_MS = 2000;  // 2s delay before processing each message
    private static final String FUNCTION_NAME = "read_claim_or_dlq";

    // Routing thresholds (updated for demo)
    public static final double HIGH_RISK_THRESHOLD = 100.0;      // >= 100 is high risk
    public static final double MANUAL_REVIEW_THRESHOLD = 10000.0; // >= 10000 needs manual review

    // Router management
    private final AtomicBoolean routerRunning = new AtomicBoolean(false);
    private final AtomicBoolean shutdown = new AtomicBoolean(false);

    /**
     * Stops the router before Spring closes the {@link JedisPool} it borrows from.
     */
    @PreDestroy
    void stopRouter() {
        log.info("Stopping content-based router");
        shutdown.set(true);
        routerRunning.set(false);
    }

    @Override
    public void run(String... args) throws Exception {
        log.info("Starting Content-Based Routing Service");

        // Clear all streams at startup for clean demo state
        clearAllStreams();

        // Start monitoring all streams
        streamListenerService.startMonitoring(INCOMING_STREAM);
        streamListenerService.startMonitoring(HIGH_RISK_STREAM);
        streamListenerService.startMonitoring(STANDARD_STREAM);
        streamListenerService.startMonitoring(MANUAL_REVIEW_STREAM);
        streamListenerService.startMonitoring(DLQ_STREAM);

        // Start the router
        startRouter();
        log.info("Content-Based Routing Service started");
    }

    private void initializeConsumerGroup() {
        try (var jedis = jedisPool.getResource()) {
            try {
                jedis.xgroupCreate(INCOMING_STREAM, CONSUMER_GROUP, new StreamEntryID(), true);
                log.info("Consumer group '{}' created for stream '{}'", CONSUMER_GROUP, INCOMING_STREAM);
            } catch (Exception e) {
                if (e.getMessage() != null && e.getMessage().contains("BUSYGROUP")) {
                    log.info("Consumer group '{}' already exists", CONSUMER_GROUP);
                } else {
                    throw e;
                }
            }
        }
    }

    private void startRouter() {
        if (routerRunning.compareAndSet(false, true)) {
            Thread.ofVirtual()
                .name("content-router")
                .start(this::routerLoop);
            log.info("Content-based router started (will process after {}ms delay)", ROUTER_STARTUP_DELAY_MS);
        }
    }

    private void routerLoop() {
        String consumerName = "payment-router";
        log.info("Router started - will wait {}ms before processing each message (for demo visibility)", ROUTER_STARTUP_DELAY_MS);

        while (routerRunning.get() && !shutdown.get()) {
            try {
                // Wait before processing each message (allows UI to see it in incoming stream)
                Thread.sleep(ROUTER_STARTUP_DELAY_MS);
                processNextPayment(consumerName);
                Thread.sleep(POLL_INTERVAL_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception e) {
                // Shutting down: Spring closes the JedisPool before these worker threads
                // notice, so the resulting pool error is expected, not a failure.
                if (shutdown.get()) break;
                log.error("Router error: {}", e.getMessage());
                try { Thread.sleep(1000); } catch (InterruptedException ie) { Thread.currentThread().interrupt(); break; }
            }
        }
        log.info("Content-based router stopped");
    }

    private void processNextPayment(String consumerName) {
        try (var jedis = jedisPool.getResource()) {
            Object result = jedis.fcall(FUNCTION_NAME,
                Arrays.asList(INCOMING_STREAM, DLQ_STREAM),
                Arrays.asList(CONSUMER_GROUP, consumerName, String.valueOf(MIN_IDLE_MS), "1", String.valueOf(MAX_DELIVERIES)));

            if (!(result instanceof List)) return;
            @SuppressWarnings("unchecked")
            List<Object> resultList = (List<Object>) result;
            if (resultList.size() < 2) return;

            processDLQMessages(resultList.get(1));

            @SuppressWarnings("unchecked")
            List<Object> messages = (List<Object>) resultList.get(0);
            for (Object msgItem : messages) {
                routePayment(jedis, msgItem);
            }
        }
    }

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
                    log.info("Payment {} routed to DLQ", originalId);
                    webSocketEventService.broadcastEvent(DLQEvent.builder()
                        .eventType(DLQEvent.EventType.MESSAGE_DELETED)
                        .messageId(originalId)
                        .streamName(INCOMING_STREAM)
                        .details("Payment routed to DLQ (max deliveries reached)")
                        .build());
                }
            }
        }
    }

    @SuppressWarnings("unchecked")
    private void routePayment(redis.clients.jedis.Jedis jedis, Object msgItem) {
        if (!(msgItem instanceof List)) return;
        List<Object> msgEntry = (List<Object>) msgItem;
        if (msgEntry.size() < 2) return;

        String messageId = convertToString(msgEntry.get(0));
        List<Object> fieldsList = (List<Object>) msgEntry.get(1);

        Map<String, String> fields = new HashMap<>();
        for (int i = 0; i < fieldsList.size(); i += 2) {
            fields.put(convertToString(fieldsList.get(i)), convertToString(fieldsList.get(i + 1)));
        }

        // A missing or non-numeric amount is a malformed message, NOT a $0 low-value payment.
        // Treat it like the negative-amount error path: do NOT ACK, so it is retried and
        // eventually routed to the DLQ after MAX_DELIVERIES.
        String rawAmount = fields.get("amount");
        double amount;
        try {
            if (rawAmount == null || rawAmount.isBlank()) {
                throw new NumberFormatException("missing amount field");
            }
            amount = Double.parseDouble(rawAmount.trim());
        } catch (NumberFormatException e) {
            log.warn("Malformed payment {} (amount='{}'): {}. Will retry (max deliveries={})",
                fields.get("paymentId"), rawAmount, e.getMessage(), MAX_DELIVERIES);
            throw new IllegalArgumentException("Malformed amount: '" + rawAmount + "'");
        }

        // Negative amounts cause an error - will NOT be ACK'd, triggering retry and eventually DLQ
        if (amount < 0) {
            log.error("Invalid payment amount: {} (negative). Will retry (max deliveries={})", amount, MAX_DELIVERIES);
            throw new IllegalArgumentException("Negative amount not allowed: " + amount);
        }

        String targetStream = determineTargetStream(amount);

        // Add routing metadata
        fields.put("_routedFrom", INCOMING_STREAM);
        fields.put("_routedAt", Instant.now().toString());
        fields.put("_routingReason", getRoutingReason(amount, targetStream));

        jedis.xadd(targetStream, XAddParams.xAddParams(), fields);
        jedis.xack(INCOMING_STREAM, CONSUMER_GROUP, new StreamEntryID(messageId));

        log.info("Routed payment {} (amount={}) to {}", fields.get("paymentId"), amount, targetStream);

        webSocketEventService.broadcastEvent(DLQEvent.builder()
            .eventType(DLQEvent.EventType.MESSAGE_DELETED)
            .messageId(messageId)
            .streamName(INCOMING_STREAM)
            .details("Routed to " + targetStream)
            .build());
    }

    /**
     * Determine target stream based on amount:
     * - amount < 0: ERROR (handled separately, goes to DLQ)
     * - 0 <= amount < 100: standard (OK, low value)
     * - 100 <= amount < 10000: highRisk (needs review)
     * - amount >= 10000: manualReview (high value, human review)
     */
    public String determineTargetStream(double amount) {
        if (amount >= MANUAL_REVIEW_THRESHOLD) return MANUAL_REVIEW_STREAM;  // >= 10000
        if (amount >= HIGH_RISK_THRESHOLD) return HIGH_RISK_STREAM;          // >= 100
        return STANDARD_STREAM;                                               // < 100
    }

    private String getRoutingReason(double amount, String targetStream) {
        if (targetStream.equals(MANUAL_REVIEW_STREAM)) return "amount >= $" + (int)MANUAL_REVIEW_THRESHOLD + " (manual review)";
        if (targetStream.equals(HIGH_RISK_STREAM)) return "$" + (int)HIGH_RISK_THRESHOLD + " <= amount < $" + (int)MANUAL_REVIEW_THRESHOLD + " (high risk)";
        return "amount < $" + (int)HIGH_RISK_THRESHOLD + " (standard)";
    }

    public String submitPayment(String paymentId, double amount, String country, String method) {
        try (var jedis = jedisPool.getResource()) {
            // Use LinkedHashMap to preserve field order: paymentId, amount first
            Map<String, String> payload = new LinkedHashMap<>();
            payload.put("paymentId", paymentId);
            payload.put("amount", String.valueOf(amount));
            payload.put("country", country);
            payload.put("method", method);
            payload.put("createdAt", Instant.now().toString());

            StreamEntryID messageId = jedis.xadd(INCOMING_STREAM, XAddParams.xAddParams(), payload);
            log.info("Submitted payment {} with amount {} to {}", paymentId, amount, INCOMING_STREAM);
            return messageId.toString();
        }
    }

    public Map<String, Object> getRoutingRules() {
        Map<String, Object> rules = new LinkedHashMap<>();
        rules.put("standard", Map.of("condition", "0 <= amount < $" + (int)HIGH_RISK_THRESHOLD, "target", STANDARD_STREAM));
        rules.put("highRisk", Map.of("condition", "$" + (int)HIGH_RISK_THRESHOLD + " <= amount < $" + (int)MANUAL_REVIEW_THRESHOLD, "target", HIGH_RISK_STREAM));
        rules.put("manualReview", Map.of("condition", "amount >= $" + (int)MANUAL_REVIEW_THRESHOLD, "target", MANUAL_REVIEW_STREAM));
        rules.put("error", Map.of("condition", "amount < 0", "target", DLQ_STREAM + " (after " + MAX_DELIVERIES + " retries)"));
        return rules;
    }

    public Map<String, String> getStreamNames() {
        Map<String, String> names = new LinkedHashMap<>();
        names.put("incomingStream", INCOMING_STREAM);
        names.put("highRiskStream", HIGH_RISK_STREAM);
        names.put("standardStream", STANDARD_STREAM);
        names.put("manualReviewStream", MANUAL_REVIEW_STREAM);
        names.put("dlqStream", DLQ_STREAM);
        return names;
    }

    public void clearAllStreams() {
        log.info("Clearing all content-based routing streams");
        try (var jedis = jedisPool.getResource()) {
            for (String stream : List.of(INCOMING_STREAM, HIGH_RISK_STREAM, STANDARD_STREAM, MANUAL_REVIEW_STREAM, DLQ_STREAM)) {
                try { jedis.del(stream); } catch (Exception e) { log.warn("Could not delete {}: {}", stream, e.getMessage()); }
            }
            initializeConsumerGroup();
            log.info("All content-based routing streams cleared");
        }
    }

    private String convertToString(Object obj) {
        if (obj instanceof byte[]) return new String((byte[]) obj);
        return obj != null ? obj.toString() : "";
    }
}
