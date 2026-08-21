package com.redis.patterns.service;

import tools.jackson.databind.ObjectMapper;
import com.redis.patterns.dto.DLQEvent;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.JedisPubSub;
import redis.clients.jedis.params.XAddParams;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * Service that listens to Redis keyspace notifications for key expiration events.
 * When a timeout key expires, it reads the shadow key and sends a TIMEOUT response.
 *
 * This implements the timeout detection mechanism for the Request/Reply pattern.
 *
 * @author Redis Patterns Team
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class KeyspaceNotificationListener extends JedisPubSub {

    private final JedisPool jedisPool;
    private final ObjectMapper objectMapper;
    private final WebSocketEventService webSocketEventService;

    private static final String TIMEOUT_KEY_PREFIX = "order.holdInventory.request.timeout.v1:";
    private static final String SHADOW_KEY_PREFIX = "order.holdInventory.request.timeout.shadow.v1:";
    private static final String RESPONSE_FUNCTION_NAME = "response";

    private static final String LLM_TIMEOUT_PREFIX = "llm:timeout:";
    private static final String LLM_TIMEOUT_SHADOW_PREFIX = "llm:timeout:shadow:";

    /**
     * Called when a message is received on a pattern-subscribed channel.
     * This is triggered when a key expires in Redis.
     *
     * For keyevent notifications:
     * - pattern: __keyevent@0__:expired
     * - channel: __keyevent@0__:expired
     * - message: order.holdInventory.request.timeout.v1:097eaf2c-d6b0-44d5-818b-42da94cbcbe6
     */
    @Override
    public void onPMessage(String pattern, String channel, String message) {
        log.info("[KEYSPACE] Received notification - pattern='{}', channel='{}', message='{}'",
                pattern, channel, message);

        // For keyevent notifications, the message contains the key name that expired
        if ("__keyevent@0__:expired".equals(channel) && message.startsWith(TIMEOUT_KEY_PREFIX)) {
            // Extract the correlation ID from the key name (message)
            String correlationId = message.substring(TIMEOUT_KEY_PREFIX.length());
            log.info("[KEYSPACE] Extracted correlationId: {}", correlationId);
            handleTimeout(correlationId);
        }

        // LLM Chat (#12) reply-timeout: a per-message key expired without the reply completing.
        if ("__keyevent@0__:expired".equals(channel)
                && message.startsWith(LLM_TIMEOUT_PREFIX)
                && !message.startsWith(LLM_TIMEOUT_SHADOW_PREFIX)) {
            handleLlmTimeout(message.substring(LLM_TIMEOUT_PREFIX.length()));
        }
    }

    /**
     * Called when a message is received on the subscribed channel.
     * This is triggered when a key expires in Redis.
     * (Not used for pattern subscriptions, but kept for compatibility)
     */
    @Override
    public void onMessage(String channel, String message) {
        log.debug("[KEYSPACE] Received notification on channel '{}': {}", channel, message);

        // Check if this is an expiration event for a timeout key
        if ("expired".equals(message) && channel.contains(TIMEOUT_KEY_PREFIX)) {
            // Extract the correlation ID from the channel name
            // Channel format: __keyevent@0__:expired or __keyspace@0__:order.holdInventory.request.timeout.v1:correlationId
            String correlationId = extractCorrelationId(channel);
            if (correlationId != null) {
                handleTimeout(correlationId);
            }
        }
    }

    /**
     * Extract correlation ID from the keyspace notification channel.
     */
    private String extractCorrelationId(String channel) {
        try {
            // Channel format: __keyspace@0__:order.holdInventory.request.timeout.v1:correlationId
            int prefixIndex = channel.indexOf(TIMEOUT_KEY_PREFIX);
            if (prefixIndex >= 0) {
                return channel.substring(prefixIndex + TIMEOUT_KEY_PREFIX.length());
            }
            return null;
        } catch (Exception e) {
            log.error("[KEYSPACE] Failed to extract correlation ID from channel: {}", channel, e);
            return null;
        }
    }

    /**
     * Handle timeout event by reading shadow key and sending TIMEOUT response.
     */
    private void handleTimeout(String correlationId) {
        log.warn("[KEYSPACE] ⏱️ TIMEOUT detected for correlationId={}", correlationId);

        try (var jedis = jedisPool.getResource()) {
            String shadowKey = SHADOW_KEY_PREFIX + correlationId;

            // Read shadow key to get metadata
            Map<String, String> shadowData = jedis.hgetAll(shadowKey);

            if (shadowData == null || shadowData.isEmpty()) {
                log.error("[KEYSPACE] Shadow key not found for correlationId={}", correlationId);
                return;
            }

            String businessId = shadowData.get("businessId");
            String streamResponseName = shadowData.get("streamResponseName");

            log.info("[KEYSPACE] Sending TIMEOUT response for correlationId={}, businessId={}", 
                    correlationId, businessId);

            // Create TIMEOUT response payload
            Map<String, Object> payload = new HashMap<>();
            payload.put("responseType", "TIMEOUT");
            payload.put("message", "Request timed out - no response received within timeout period");
            payload.put("timeoutSeconds", 60);

            String payloadJson = objectMapper.writeValueAsString(payload);

            // Send TIMEOUT response using the response Lua function
            // Note: We don't need the timeout_key here since it already expired
            String timeoutKey = TIMEOUT_KEY_PREFIX + correlationId;
            
            Object result = jedis.fcall(
                RESPONSE_FUNCTION_NAME,
                java.util.Arrays.asList(timeoutKey, streamResponseName),
                java.util.Arrays.asList(correlationId, businessId, payloadJson)
            );

            log.info("[KEYSPACE] TIMEOUT response sent for correlationId={} (message ID: {})", 
                    correlationId, result);

            // Clean up shadow key
            jedis.del(shadowKey);
            log.debug("[KEYSPACE] Shadow key deleted for correlationId={}", correlationId);

            // Broadcast timeout event via WebSocket
            broadcastTimeoutEvent(correlationId, businessId);

        } catch (Exception e) {
            log.error("[KEYSPACE] Failed to handle timeout for correlationId={}", correlationId, e);
        }
    }

    /**
     * LLM Chat (#12) reply timeout: the per-message key expired before a reply completed. We read the
     * shadow hash (which survives the expiry) to find the conversation, then post a system notice into
     * it so the user is told their message failed — driven entirely by the Redis keyspace notification.
     */
    private void handleLlmTimeout(String msgId) {
        try (var jedis = jedisPool.getResource()) {
            String shadowKey = LlmChatService.timeoutShadowKey(msgId);
            Map<String, String> shadow = jedis.hgetAll(shadowKey);
            String cid = shadow == null ? null : shadow.get("cid");
            if (cid == null) {
                return; // reply completed in time (key + shadow already deleted) — nothing to do
            }
            log.warn("[KEYSPACE] ⏱️ LLM reply timeout for cid={} msgId={}", cid, msgId);

            String notice = "⏱ No response within the timeout — detected via a Redis keyspace "
                    + "notification (the per-message timeout key expired). Your message failed to get a "
                    + "reply; if it kept failing it was routed to the Dead Letter Queue.";
            jedis.xadd(LlmChatService.chatKey(cid),
                    XAddParams.xAddParams().maxLen(200).approximateTrimming(),
                    Map.of(
                            "role", "system",
                            "content", notice,
                            "ts", String.valueOf(System.currentTimeMillis()),
                            "msgId", UUID.randomUUID().toString(),
                            "model", "timeout"));
            jedis.del(shadowKey);
        } catch (Exception e) {
            log.error("[KEYSPACE] Failed to handle LLM timeout for msgId={}", msgId, e);
        }
    }

    /**
     * Broadcast timeout event to WebSocket clients.
     */
    private void broadcastTimeoutEvent(String correlationId, String businessId) {
        try {
            // Create DLQEvent for timeout notification
            DLQEvent event = DLQEvent.builder()
                .eventType(DLQEvent.EventType.INFO)
                .messageId(correlationId)
                .streamName("order.holdInventory.response.v1")
                .details(String.format("TIMEOUT_DETECTED: correlationId=%s, businessId=%s, reason=Request timeout - no response received",
                        correlationId, businessId))
                .build();

            webSocketEventService.broadcastEvent(event);
            log.debug("[KEYSPACE] Timeout event broadcasted to WebSocket clients");

        } catch (Exception e) {
            log.error("[KEYSPACE] Failed to broadcast timeout event", e);
        }
    }
}

