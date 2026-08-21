package com.redis.patterns.service;

import tools.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.CommandLineRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Service;
import redis.clients.jedis.JedisPool;

import java.time.Instant;
import java.util.*;

/**
 * Service implementing the Topic Routing pattern.
 * 
 * Messages are routed to different streams based on routing key patterns,
 * similar to RabbitMQ's topic exchange.
 * 
 * Routing rules:
 *   order.* -> events.order.v1
 *   inventory.* -> events.inventory.v1
 *   notification.* -> events.notification.v1
 *   *.critical -> events.alert.v1
 */
@Slf4j
@Service
@RequiredArgsConstructor
@Order(3)
public class TopicRoutingService implements CommandLineRunner {

    private final JedisPool jedisPool;
    private final RedisStreamListenerService streamListenerService;
    private final ObjectMapper objectMapper;

    // Stream names - Order Routing Demo
    public static final String EXCHANGE_STREAM = "events.topic.v1";
    public static final String ORDER_V1_STREAM = "events.order.v1";
    public static final String ORDER_V2_STREAM = "events.order.v2";
    public static final String VIP_NOTIFICATION_STREAM = "events.notification.vip";
    public static final String GDPR_NOTIFICATION_STREAM = "events.notification.gdpr";
    public static final String CANCELLED_AUDIT_STREAM = "events.audit.cancelled";

    // Lua function name
    private static final String FUNCTION_NAME = "route_message";

    // Available routing keys for the UI - Order Routing Demo
    public static final List<String> AVAILABLE_ROUTING_KEYS = List.of(
        // PLACED orders - demonstrate multi-destination routing
        "order.place.regular.us.v1",    // → v1 only
        "order.place.regular.eu.v1",    // → v1 + GDPR
        "order.place.regular.us.v2",    // → v2 only
        "order.place.regular.eu.v2",    // → v2 + GDPR
        "order.place.vip.us.v1",        // → v1 + VIP
        "order.place.vip.us.v2",        // → v2 + VIP
        "order.place.vip.eu.v1",        // → v1 + VIP + GDPR (max distribution!)
        "order.place.vip.eu.v2",        // → v2 + VIP + GDPR (max distribution!)
        // CANCELLED orders - demonstrate STOP ON MATCH
        "order.cancelled.regular.us.v1", // → Audit ONLY (STOP!)
        "order.cancelled.regular.eu.v1", // → Audit ONLY (STOP! no GDPR)
        "order.cancelled.vip.us.v1",     // → Audit ONLY (STOP! no VIP)
        "order.cancelled.vip.eu.v1"      // → Audit ONLY (STOP! no VIP, no GDPR)
    );

    @Override
    public void run(String... args) throws Exception {
        log.info("Starting Topic Routing Service");

        // Start monitoring all streams for WebSocket broadcasts
        streamListenerService.startMonitoring(EXCHANGE_STREAM);
        streamListenerService.startMonitoring(ORDER_V1_STREAM);
        streamListenerService.startMonitoring(ORDER_V2_STREAM);
        streamListenerService.startMonitoring(VIP_NOTIFICATION_STREAM);
        streamListenerService.startMonitoring(GDPR_NOTIFICATION_STREAM);
        streamListenerService.startMonitoring(CANCELLED_AUDIT_STREAM);

        log.info("Topic Routing Service started - monitoring all streams");
    }

    /**
     * Route a message based on its routing key.
     * 
     * @param routingKey The routing key (e.g., "order.created")
     * @param eventId Event identifier
     * @param additionalData Additional payload data
     * @return Routing result with exchange ID and routed streams
     */
    public RoutingResult routeMessage(String routingKey, String eventId, Map<String, Object> additionalData) {
        try (var jedis = jedisPool.getResource()) {
            // Build payload
            Map<String, Object> payload = new HashMap<>();
            payload.put("eventId", eventId);
            payload.put("createdAt", Instant.now().toString());
            if (additionalData != null) {
                payload.putAll(additionalData);
            }

            String payloadJson = objectMapper.writeValueAsString(payload);

            // Call Lua function
            Object result = jedis.fcall(
                FUNCTION_NAME,
                Collections.singletonList(EXCHANGE_STREAM),
                Arrays.asList(routingKey, payloadJson)
            );

            // Parse result
            return parseRoutingResult(result, routingKey);

        } catch (Exception e) {
            log.error("Failed to route message with key {}: {}", routingKey, e.getMessage());
            throw new RuntimeException("Failed to route message", e);
        }
    }

    /**
     * Parse the Lua function result into a RoutingResult object.
     */
    @SuppressWarnings("unchecked")
    private RoutingResult parseRoutingResult(Object result, String routingKey) {
        RoutingResult routingResult = new RoutingResult();
        routingResult.setRoutingKey(routingKey);

        if (result instanceof List) {
            List<Object> resultList = (List<Object>) result;
            
            if (resultList.size() >= 1) {
                routingResult.setExchangeId(convertToString(resultList.get(0)));
            }
            
            if (resultList.size() >= 2 && resultList.get(1) instanceof List) {
                List<Object> routedTo = (List<Object>) resultList.get(1);
                List<RoutedStream> streams = new ArrayList<>();
                
                for (Object item : routedTo) {
                    if (item instanceof List) {
                        List<Object> streamEntry = (List<Object>) item;
                        if (streamEntry.size() >= 2) {
                            RoutedStream rs = new RoutedStream();
                            rs.setStreamName(convertToString(streamEntry.get(0)));
                            rs.setMessageId(convertToString(streamEntry.get(1)));
                            streams.add(rs);
                        }
                    }
                }
                routingResult.setRoutedTo(streams);
            }
        }

        log.info("Routed message with key '{}' to {} streams", routingKey, 
            routingResult.getRoutedTo() != null ? routingResult.getRoutedTo().size() : 0);

        return routingResult;
    }

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
        names.put("exchangeStream", EXCHANGE_STREAM);
        names.put("orderV1Stream", ORDER_V1_STREAM);
        names.put("orderV2Stream", ORDER_V2_STREAM);
        names.put("vipNotificationStream", VIP_NOTIFICATION_STREAM);
        names.put("gdprNotificationStream", GDPR_NOTIFICATION_STREAM);
        names.put("cancelledAuditStream", CANCELLED_AUDIT_STREAM);
        return names;
    }

    /**
     * Get available routing keys.
     */
    public List<String> getAvailableRoutingKeys() {
        return AVAILABLE_ROUTING_KEYS;
    }

    /**
     * Clear all topic routing streams.
     */
    public void clearAllStreams() {
        log.info("Clearing all topic routing streams");

        try (var jedis = jedisPool.getResource()) {
            List<String> streamsToDelete = List.of(
                EXCHANGE_STREAM,
                ORDER_V1_STREAM,
                ORDER_V2_STREAM,
                VIP_NOTIFICATION_STREAM,
                GDPR_NOTIFICATION_STREAM,
                CANCELLED_AUDIT_STREAM
            );

            for (String stream : streamsToDelete) {
                try {
                    jedis.del(stream);
                    log.debug("Deleted stream: {}", stream);
                } catch (Exception e) {
                    log.warn("Could not delete stream {}: {}", stream, e.getMessage());
                }
            }

            log.info("All topic routing streams cleared");
        }
    }

    // DTO classes for routing results
    @lombok.Data
    public static class RoutingResult {
        private String routingKey;
        private String exchangeId;
        private List<RoutedStream> routedTo = new ArrayList<>();
    }

    @lombok.Data
    public static class RoutedStream {
        private String streamName;
        private String messageId;
    }
}

