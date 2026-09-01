package com.redis.patterns.controller;

import com.redis.patterns.service.PubSubTopicRoutingService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.Map;

/**
 * REST Controller for PubSub Topic Routing pattern.
 * 
 * Implements RabbitMQ-like Topic Exchange using Redis Pub/Sub with PSUBSCRIBE.
 * Channels: order.eu.created, order.us.cancelled, etc.
 * Pattern subscribers: order.eu.*, order.*.created
 */
@Slf4j
@RestController
@RequestMapping("/pubsub-topic-routing")
@RequiredArgsConstructor
public class PubSubTopicRoutingController {

    private final PubSubTopicRoutingService pubSubTopicRoutingService;

    /**
     * Publishes a message to a routing key (channel).
     * 
     * Request body format:
     * {
     *   "routingKey": "order.eu.created",
     *   "payload": {
     *     "orderId": "12345",
     *     "region": "eu",
     *     "action": "created"
     *   }
     * }
     */
    @PostMapping("/publish")
    public ResponseEntity<Map<String, Object>> publishMessage(@RequestBody Map<String, Object> request) {
        log.info("Received publish request: {}", request);

        try {
            String routingKey = (String) request.get("routingKey");
            @SuppressWarnings("unchecked")
            Map<String, String> payload = (Map<String, String>) request.get("payload");

            if (routingKey == null || routingKey.isBlank()) {
                return ResponseEntity.badRequest().body(Map.of(
                    "success", false,
                    "error", "Routing key is required"
                ));
            }

            if (payload == null || payload.isEmpty()) {
                return ResponseEntity.badRequest().body(Map.of(
                    "success", false,
                    "error", "Payload is required"
                ));
            }

            long subscriberCount = pubSubTopicRoutingService.publishMessage(routingKey, payload);

            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("routingKey", routingKey);
            response.put("subscriberCount", subscriberCount);
            response.put("message", String.format("Message routed to %d pattern subscribers", subscriberCount));
            return ResponseEntity.ok(response);

        } catch (Exception e) {
            log.error("Error publishing message", e);
            return ResponseEntity.internalServerError().body(Map.of(
                "success", false,
                "error", e.getMessage()
            ));
        }
    }

    /**
     * Returns all active pattern subscriptions.
     */
    @GetMapping("/subscriptions")
    public ResponseEntity<Map<String, Object>> getSubscriptions() {
        Map<String, Object> response = new HashMap<>();
        response.put("success", true);
        response.put("subscriptions", pubSubTopicRoutingService.getActiveSubscriptions());
        return ResponseEntity.ok(response);
    }

    /**
     * Returns available routing key templates.
     */
    @GetMapping("/routing-keys")
    public ResponseEntity<Map<String, Object>> getRoutingKeys() {
        Map<String, Object> response = new HashMap<>();
        response.put("success", true);
        response.put("routingKeys", Map.of(
            "order.eu.created", "EU order created",
            "order.eu.cancelled", "EU order cancelled",
            "order.us.created", "US order created",
            "order.us.cancelled", "US order cancelled",
            "order.asia.created", "Asia order created",
            "order.asia.cancelled", "Asia order cancelled"
        ));
        response.put("patterns", Map.of(
            "EU Compliance", PubSubTopicRoutingService.EU_COMPLIANCE_PATTERN,
            "Order Audit", PubSubTopicRoutingService.ORDER_AUDIT_PATTERN,
            "US Orders", PubSubTopicRoutingService.US_ORDERS_PATTERN
        ));
        return ResponseEntity.ok(response);
    }

    @GetMapping("/health")
    public ResponseEntity<Map<String, Object>> health() {
        return ResponseEntity.ok(Map.of(
            "status", "UP",
            "service", "PubSubTopicRouting"
        ));
    }
}

