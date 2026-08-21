package com.redis.patterns.service;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import com.redis.patterns.dto.DLQEvent;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.DependsOn;
import org.springframework.stereotype.Service;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.StreamEntryID;
import redis.clients.jedis.params.XReadGroupParams;
import redis.clients.jedis.resps.StreamEntry;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.*;

/**
 * Service for Request/Reply pattern operations.
 * 
 * This service is INDEPENDENT from DLQ and PubSub features.
 * It handles Request/Reply pattern with timeout management.
 */
@Slf4j
@Service
// This service starts request/response listener threads in @PostConstruct that
// immediately FCALL the Lua functions. Depend on the loader so its @PostConstruct
// registers the `stream_utils` library first — otherwise the response listener
// races ahead and logs "ERR Function not found" on startup.
@DependsOn("redisLuaFunctionLoader")
@RequiredArgsConstructor
public class RequestReplyService {

    private final JedisPool jedisPool;
    private final ObjectMapper objectMapper;
    private final WebSocketEventService webSocketEventService;

    /** Flipped by {@link #stopListeners()} so the listeners stop before the pool closes. */
    private final AtomicBoolean shutdown = new AtomicBoolean(false);
    private Thread requestListenerThread;
    private Thread responseListenerThread;

    private static final String REQUEST_STREAM = "order.holdInventory.v1";
    private static final String RESPONSE_STREAM = "order.holdInventory.response.v1";
    private static final String REQUEST_CONSUMER_GROUP = "inventory-service";
    private static final String REQUEST_CONSUMER_NAME = "worker-1";
    private static final String RESPONSE_CONSUMER_GROUP = "response-listener";
    private static final String RESPONSE_CONSUMER_NAME = "listener-1";
    private static final String TIMEOUT_KEY_PREFIX = "order.holdInventory.request.timeout.v1:";
    private static final String SHADOW_KEY_PREFIX = "order.holdInventory.request.timeout.shadow.v1:";
    private static final int TIMEOUT_SECONDS = 10;
    private static final String REQUEST_FUNCTION_NAME = "request";
    private static final String RESPONSE_FUNCTION_NAME = "response";
    private static final String READ_CLAIM_OR_DLQ_FUNCTION_NAME = "read_claim_or_dlq";
    private static final String RESPONSE_DLQ_STREAM = "order.holdInventory.response.v1:dlq";
    private static final long MIN_IDLE_TIME_MS = 5000; // 5 seconds
    private static final int MAX_DELIVERY_COUNT = 2; // 2 errors in cycle, so max 2 deliveries

    // Removed cyclic response counter - now using responseType from request payload

    /**
     * Send a request using Lua function.
     * Returns the correlation ID.
     */
    public String sendRequest(Map<String, Object> request) throws Exception {
        log.info("[REQUESTER] Sending request: {}", request);

        String correlationId = UUID.randomUUID().toString();
        String orderId = (String) request.get("orderId");
        String payloadJson = objectMapper.writeValueAsString(request);

        String timeoutKey = TIMEOUT_KEY_PREFIX + correlationId;
        String shadowKey = SHADOW_KEY_PREFIX + correlationId;

        try (var jedis = jedisPool.getResource()) {
            // Call Lua function: request
            // KEYS: [timeout_key, shadow_key, stream_name]
            // ARGS: [correlation_id, business_id, stream_response_name, timeout, payload_json]
            Object result = jedis.fcall(
                REQUEST_FUNCTION_NAME,
                Arrays.asList(timeoutKey, shadowKey, REQUEST_STREAM),
                Arrays.asList(correlationId, orderId, RESPONSE_STREAM,
                             String.valueOf(TIMEOUT_SECONDS), payloadJson)
            );

            log.info("[REQUESTER] Request sent with correlation ID: {} (message ID: {})", correlationId, result);
            return correlationId;
        }
    }

    /**
     * Initialize consumer groups and start listeners.
     */
    @PostConstruct
    public void initializeConsumerGroups() {
        log.info("[INIT] Initializing consumer groups for Request/Reply pattern...");

        try (var jedis = jedisPool.getResource()) {
            // Create consumer group for request stream
            // Use "0-0" to read from the beginning of the stream
            try {
                jedis.xgroupCreate(REQUEST_STREAM, REQUEST_CONSUMER_GROUP, new StreamEntryID("0-0"), true);
                log.info("[INIT] Created consumer group '{}' for stream '{}' (reading from beginning)", REQUEST_CONSUMER_GROUP, REQUEST_STREAM);
            } catch (Exception e) {
                if (e.getMessage().contains("BUSYGROUP")) {
                    log.info("[INIT] Consumer group '{}' already exists for stream '{}'", REQUEST_CONSUMER_GROUP, REQUEST_STREAM);
                } else {
                    throw e;
                }
            }

            // Create consumer group for response stream
            // Use "0-0" to read from the beginning of the stream
            try {
                jedis.xgroupCreate(RESPONSE_STREAM, RESPONSE_CONSUMER_GROUP, new StreamEntryID("0-0"), true);
                log.info("[INIT] Created consumer group '{}' for stream '{}' (reading from beginning)", RESPONSE_CONSUMER_GROUP, RESPONSE_STREAM);
            } catch (Exception e) {
                if (e.getMessage().contains("BUSYGROUP")) {
                    log.info("[INIT] Consumer group '{}' already exists for stream '{}'", RESPONSE_CONSUMER_GROUP, RESPONSE_STREAM);
                } else {
                    throw e;
                }
            }

        } catch (Exception e) {
            log.error("[INIT] Failed to initialize consumer groups", e);
            return;
        }

        // Start virtual threads OUTSIDE the try-with-resources to avoid closing Jedis connection
        try {
            log.info("[INIT] Starting request listener virtual thread...");
            requestListenerThread = Thread.ofVirtual().name("request-listener").start(this::listenForRequests);
            log.info("[INIT] Started virtual thread to listen for requests on {}", REQUEST_STREAM);
        } catch (Exception e) {
            log.error("[INIT] Failed to start request listener thread", e);
        }

        try {
            log.info("[INIT] Starting response listener virtual thread...");
            responseListenerThread = Thread.ofVirtual().name("response-listener").start(this::listenForResponses);
            log.info("[INIT] Started virtual thread to listen for responses on {}", RESPONSE_STREAM);
        } catch (Exception e) {
            log.error("[INIT] Failed to start response listener thread", e);
        }
    }

    /**
     * Stops both listeners before Spring closes the {@link JedisPool} they borrow from.
     * They block up to 5s in XREADGROUP, hence the interrupt on top of the flag.
     */
    @PreDestroy
    void stopListeners() {
        log.info("[SHUTDOWN] Stopping request/response listeners");
        shutdown.set(true);
        if (requestListenerThread != null) {
            requestListenerThread.interrupt();
        }
        if (responseListenerThread != null) {
            responseListenerThread.interrupt();
        }
    }

    /**
     * Listen for incoming requests and generate responses.
     * Runs in a virtual thread.
     */
    private void listenForRequests() {
        log.info("[WORKER] Request listener started, waiting for requests on '{}'...", REQUEST_STREAM);
        log.info("[WORKER] Consumer group: '{}', Consumer name: '{}'", REQUEST_CONSUMER_GROUP, REQUEST_CONSUMER_NAME);

        while (!shutdown.get() && !Thread.currentThread().isInterrupted()) {
            try (var jedis = jedisPool.getResource()) {
                // Use block(5000) to wait up to 5 seconds for new messages
                // StreamEntryID.UNRECEIVED_ENTRY is the equivalent of ">" in Redis CLI
                var entries = jedis.xreadGroup(
                    REQUEST_CONSUMER_GROUP,
                    REQUEST_CONSUMER_NAME,
                    XReadGroupParams.xReadGroupParams().count(10).block(5000),
                    Map.of(REQUEST_STREAM, StreamEntryID.XREADGROUP_UNDELIVERED_ENTRY)
                );

                // Check if we got any actual messages
                boolean hasMessages = false;
                if (entries != null && !entries.isEmpty()) {
                    for (var streamEntries : entries) {
                        if (streamEntries.getValue() != null && !streamEntries.getValue().isEmpty()) {
                            hasMessages = true;
                            log.info("[WORKER] Received {} message(s) from stream '{}'",
                                    streamEntries.getValue().size(), streamEntries.getKey());

                            for (StreamEntry entry : streamEntries.getValue()) {
                                log.info("[WORKER] Processing message ID: {}", entry.getID());
                                boolean shouldAck = processRequest(entry);
                                if (shouldAck) {
                                    jedis.xack(REQUEST_STREAM, REQUEST_CONSUMER_GROUP, entry.getID());
                                    log.info("[WORKER] Message {} acknowledged", entry.getID());
                                } else {
                                    log.info("[WORKER] Message {} NOT acknowledged (will be retried)", entry.getID());
                                }
                            }
                        }
                    }
                }

                // If XREADGROUP returned empty result (shouldn't happen with block, but just in case)
                if (!hasMessages && (entries == null || entries.isEmpty() ||
                    entries.stream().allMatch(e -> e.getValue() == null || e.getValue().isEmpty()))) {
                    // Sleep briefly to avoid tight loop
                    Thread.sleep(100);
                }

            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception e) {
                // Shutting down: Spring closes the JedisPool before these listeners
                // notice, so the resulting pool error is expected, not a failure.
                if (shutdown.get()) break;
                log.error("[WORKER] Error in request listener", e);
                try {
                    Thread.sleep(1000);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }

        log.info("[WORKER] Request listener stopped");
    }

    /**
     * Helper method to convert Object to String (handles both byte[] and String)
     */
    private String objectToString(Object obj) {
        if (obj instanceof byte[]) {
            return new String((byte[]) obj);
        } else if (obj instanceof String) {
            return (String) obj;
        } else {
            return String.valueOf(obj);
        }
    }

    /**
     * Listen for responses and broadcast them via WebSocket.
     * Uses read_claim_or_dlq Lua function to handle DLQ routing.
     * Runs in a virtual thread.
     */
    private void listenForResponses() {
        log.info("[RESPONSE_PROCESSOR] Response listener started, waiting for responses on '{}'...", RESPONSE_STREAM);
        log.info("[RESPONSE_PROCESSOR] Consumer group: '{}', Consumer name: '{}'", RESPONSE_CONSUMER_GROUP, RESPONSE_CONSUMER_NAME);
        log.info("[RESPONSE_PROCESSOR] Using read_claim_or_dlq with minIdle={}ms, maxDeliver={}", MIN_IDLE_TIME_MS, MAX_DELIVERY_COUNT);

        while (!shutdown.get() && !Thread.currentThread().isInterrupted()) {
            try (var jedis = jedisPool.getResource()) {
                // Call Lua function: read_claim_or_dlq
                // KEYS: [stream, dlq]
                // ARGS: [group, consumer, minIdle, count, maxDeliver]
                @SuppressWarnings("unchecked")
                List<Object> result = (List<Object>) jedis.fcall(
                    READ_CLAIM_OR_DLQ_FUNCTION_NAME,
                    Arrays.asList(RESPONSE_STREAM, RESPONSE_DLQ_STREAM),
                    Arrays.asList(
                        RESPONSE_CONSUMER_GROUP,
                        RESPONSE_CONSUMER_NAME,
                        String.valueOf(MIN_IDLE_TIME_MS),
                        "10", // count
                        String.valueOf(MAX_DELIVERY_COUNT)
                    )
                );

                // Result format: [messages_to_process, dlq_ids]
                @SuppressWarnings("unchecked")
                List<Object> messagesToProcess = (List<Object>) result.get(0);
                @SuppressWarnings("unchecked")
                List<Object> dlqIds = (List<Object>) result.get(1);

                // Log DLQ movements
                if (!dlqIds.isEmpty()) {
                    log.warn("[RESPONSE_PROCESSOR] ⚠️ {} message(s) moved to DLQ: {}", dlqIds.size() / 2, RESPONSE_DLQ_STREAM);
                    for (int i = 0; i < dlqIds.size(); i += 2) {
                        String originalId = objectToString(dlqIds.get(i));
                        String dlqId = objectToString(dlqIds.get(i + 1));
                        log.warn("[RESPONSE_PROCESSOR] Message {} moved to DLQ with ID {}", originalId, dlqId);
                    }
                }

                // Process messages
                if (!messagesToProcess.isEmpty()) {
                    log.info("[RESPONSE_PROCESSOR] Received {} response(s) from stream '{}'",
                            messagesToProcess.size(), RESPONSE_STREAM);

                    for (Object msgObj : messagesToProcess) {
                        @SuppressWarnings("unchecked")
                        List<Object> msgData = (List<Object>) msgObj;
                        String messageId = objectToString(msgData.get(0));

                        @SuppressWarnings("unchecked")
                        List<Object> fieldsRaw = (List<Object>) msgData.get(1);
                        Map<String, String> fields = new HashMap<>();
                        for (int i = 0; i < fieldsRaw.size(); i += 2) {
                            String key = objectToString(fieldsRaw.get(i));
                            String value = objectToString(fieldsRaw.get(i + 1));
                            fields.put(key, value);
                        }

                        log.info("[RESPONSE_PROCESSOR] Processing response ID: {}", messageId);

                        // Create StreamEntry for compatibility with existing code
                        StreamEntry entry = new StreamEntry(new StreamEntryID(messageId), fields);
                        broadcastResponse(entry);

                        // ACK the message
                        jedis.xack(RESPONSE_STREAM, RESPONSE_CONSUMER_GROUP, new StreamEntryID(messageId));
                        log.info("[RESPONSE_PROCESSOR] Response {} acknowledged", messageId);
                    }
                } else {
                    // No messages, sleep briefly to avoid tight loop
                    Thread.sleep(100);
                }

            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception e) {
                // Shutting down: Spring closes the JedisPool before these listeners
                // notice, so the resulting pool error is expected, not a failure.
                if (shutdown.get()) break;
                log.error("[RESPONSE_PROCESSOR] Error in response listener", e);
                try {
                    Thread.sleep(1000);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }

        log.info("[RESPONSE_PROCESSOR] Response listener stopped");
    }

    /**
     * Process incoming request and respond based on responseType field in the request.
     * Returns true if message should be acknowledged, false otherwise.
     *
     * Response types: OK, KO, ERROR (no ack), TIMEOUT (no ack, no response)
     */
    private boolean processRequest(StreamEntry entry) {
        Map<String, String> fields = entry.getFields();
        String correlationId = fields.get("correlationId");
        String businessId = fields.get("businessId");
        String itemsJson = fields.get("items");
        String responseType = fields.get("responseType"); // Read from request payload

        log.info("[WORKER] Processing request: correlationId={}, businessId={}, responseType={}",
                correlationId, businessId, responseType);

        // Default to OK if responseType is not specified
        if (responseType == null || responseType.isEmpty()) {
            responseType = "OK";
            log.warn("[WORKER] No responseType specified, defaulting to OK");
        }

        try {
            switch (responseType.toUpperCase()) {
                case "OK" -> {
                    sendOkResponse(correlationId, businessId, itemsJson);
                    return true; // ACK
                }
                case "KO" -> {
                    sendKoResponse(correlationId, businessId, itemsJson);
                    return true; // ACK
                }
                case "ERROR" -> {
                    // ERROR: Send ERROR response, log, do NOT ack
                    log.error("[WORKER] ❌ ERROR for correlationId={}: Simulating business error", correlationId);
                    sendErrorResponse(correlationId, businessId);
                    log.error("[WORKER] Message will NOT be acknowledged and will be retried");
                    return false; // NO ACK
                }
                case "TIMEOUT" -> {
                    // TIMEOUT: Do nothing, do NOT ack, do NOT send response
                    log.warn("[WORKER] ⏱️ TIMEOUT SIMULATION FOR CORRELATIONID={} - NO RESPONSE SENT, NO ACK", correlationId);
                    return false; // NO ACK
                }
                default -> {
                    log.error("[WORKER] Unknown response type: {}, defaulting to OK", responseType);
                    sendOkResponse(correlationId, businessId, itemsJson);
                    return true; // ACK
                }
            }
        } catch (Exception e) {
            log.error("[WORKER] ❌ Exception caught while processing request: {}", e.getMessage());
            log.error("[WORKER] Sending ERROR response to client");
            try {
                sendErrorResponse(correlationId, businessId);
            } catch (Exception ex) {
                log.error("[WORKER] Failed to send ERROR response: {}", ex.getMessage());
            }
            return false; // NO ACK on error
        }
    }

    /**
     * Send OK response (Inventory Hold).
     */
    private void sendOkResponse(String correlationId, String businessId, String itemsJson) throws Exception {
        log.info("[WORKER] Sending OK response for correlationId={}", correlationId);

        List<Map<String, Object>> items = objectMapper.readValue(itemsJson, new TypeReference<>() {});
        List<Map<String, Object>> responseItems = new ArrayList<>();

        for (Map<String, Object> item : items) {
            Map<String, Object> responseItem = new HashMap<>();
            responseItem.put("itemId", item.get("itemId"));
            responseItem.put("quantity", item.get("quantity"));
            responseItems.add(responseItem);
        }

        Map<String, Object> payload = new HashMap<>();
        payload.put("responseType", "OK");
        payload.put("items", responseItems);

        sendResponse(correlationId, businessId, payload);
    }

    /**
     * Send KO response (Out of Stock).
     */
    private void sendKoResponse(String correlationId, String businessId, String itemsJson) throws Exception {
        log.info("[WORKER] Sending KO response for correlationId={}", correlationId);

        List<Map<String, Object>> items = objectMapper.readValue(itemsJson, new TypeReference<>() {});
        List<Map<String, Object>> outOfStockItems = new ArrayList<>();

        for (Map<String, Object> item : items) {
            Map<String, Object> outOfStockItem = new HashMap<>();
            outOfStockItem.put("itemId", item.get("itemId"));
            outOfStockItem.put("quantityAsked", item.get("quantity"));
            outOfStockItem.put("quantityAvailable", 0);
            outOfStockItems.add(outOfStockItem);
        }

        Map<String, Object> payload = new HashMap<>();
        payload.put("responseType", "KO");
        payload.put("outOfStockItems", outOfStockItems);

        sendResponse(correlationId, businessId, payload);
    }

    /**
     * Send ERROR response.
     */
    private void sendErrorResponse(String correlationId, String businessId) throws Exception {
        log.info("[WORKER] Sending ERROR response for correlationId={}", correlationId);

        Map<String, Object> payload = new HashMap<>();
        payload.put("responseType", "ERROR");
        payload.put("errorCorrelationId", UUID.randomUUID().toString());
        payload.put("errorMessage", "Inventory service temporarily unavailable - database connection timeout");

        sendResponse(correlationId, businessId, payload);
    }

    /**
     * Send response using Lua function.
     */
    private void sendResponse(String correlationId, String businessId, Map<String, Object> payload) throws Exception {
        try (var jedis = jedisPool.getResource()) {
            String payloadJson = objectMapper.writeValueAsString(payload);
            String timeoutKey = TIMEOUT_KEY_PREFIX + correlationId;

            log.info("[WORKER] Calling Lua function 'response' for correlationId={}", correlationId);

            // Call Lua function: response
            // KEYS: [timeout_key, stream_name]
            // ARGS: [correlation_id, business_id, payload_json]
            Object result = jedis.fcall(
                RESPONSE_FUNCTION_NAME,
                Arrays.asList(timeoutKey, RESPONSE_STREAM),
                Arrays.asList(correlationId, businessId, payloadJson)
            );

            log.info("[WORKER] Response sent for correlationId={} (message ID: {})", correlationId, result);
        }
    }

    /**
     * Broadcast response to WebSocket clients.
     */
    private void broadcastResponse(StreamEntry entry) {
        try {
            Map<String, String> fields = entry.getFields();
            String correlationId = fields.get("correlationId");
            String businessId = fields.get("businessId");
            String responseType = fields.get("responseType");

            log.info("[RESPONSE_PROCESSOR] Broadcasting response: correlationId={}, type={}", correlationId, responseType);

            // Guard against a response entry that lacks responseType: the message has already
            // been XACKed by the caller, so a NPE in the switch below would silently drop it.
            // Treat a missing type as UNKNOWN and still broadcast what we have.
            if (responseType == null) {
                log.warn("[RESPONSE_PROCESSOR] Response {} has no responseType; treating as UNKNOWN", correlationId);
                responseType = "UNKNOWN";
            }

            // Build WebSocket event data
            Map<String, Object> eventData = new HashMap<>();
            eventData.put("correlationId", correlationId);
            eventData.put("orderId", businessId);
            eventData.put("responseType", responseType);

            // Add type-specific data
            switch (responseType) {
                case "OK" -> {
                    String itemsJson = fields.get("items");
                    if (itemsJson != null) {
                        eventData.put("items", objectMapper.readValue(itemsJson, new TypeReference<List<Map<String, Object>>>() {}));
                    }
                }
                case "KO" -> {
                    String outOfStockJson = fields.get("outOfStockItems");
                    if (outOfStockJson != null) {
                        eventData.put("outOfStockItems", objectMapper.readValue(outOfStockJson, new TypeReference<List<Map<String, Object>>>() {}));
                    }
                }
                case "ERROR" -> {
                    eventData.put("errorCorrelationId", fields.get("errorCorrelationId"));
                    eventData.put("errorMessage", fields.get("errorMessage"));
                }
                case "TIMEOUT" -> {
                    // No additional data needed
                }
                default -> {
                    // Unknown/unsupported response type: broadcast the base event without
                    // type-specific data rather than throwing (message was already XACKed).
                    log.warn("[RESPONSE_PROCESSOR] Unknown responseType '{}' for correlationId={}; broadcasting as-is",
                        responseType, correlationId);
                }
            }

            // Convert to JSON string for details field
            String eventDataJson = objectMapper.writeValueAsString(eventData);

            // Create DLQEvent with custom event type
            DLQEvent event = DLQEvent.builder()
                .eventType(DLQEvent.EventType.INFO)
                .messageId(correlationId)
                .streamName(RESPONSE_STREAM)
                .details("REQUEST_REPLY_RESPONSE:" + eventDataJson)
                .build();

            log.info("[RESPONSE_PROCESSOR] Broadcasting WebSocket event: {}", event);
            webSocketEventService.broadcastEvent(event);
            log.info("[RESPONSE_PROCESSOR] WebSocket event broadcasted successfully");

        } catch (Exception e) {
            log.error("Error broadcasting response", e);
        }
    }
}
