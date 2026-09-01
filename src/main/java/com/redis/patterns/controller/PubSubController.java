package com.redis.patterns.controller;

import com.redis.patterns.service.PubSubService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.Map;

/**
 * REST Controller for Pub/Sub messaging pattern.
 * 
 * Provides endpoints for:
 * - Publishing messages to Redis Pub/Sub channels
 * 
 * @author Redis Patterns Team
 */
@Slf4j
@RestController
@RequestMapping("/pubsub")
@RequiredArgsConstructor
public class PubSubController {

    private final PubSubService pubSubService;

    /**
     * Publishes a message to a Redis Pub/Sub channel.
     * 
     * Request body format:
     * {
     *   "channel": "fire-and-forget",
     *   "payload": {
     *     "type": "order",
     *     "id": "12345",
     *     "status": "created"
     *   }
     * }
     * 
     * @param request Request containing channel and payload
     * @return Response with subscriber count and status
     */
    @PostMapping("/publish")
    public ResponseEntity<Map<String, Object>> publishMessage(@RequestBody Map<String, Object> request) {
        log.info("Received publish request: {}", request);

        try {
            // Extract channel and payload
            String channel = (String) request.get("channel");
            @SuppressWarnings("unchecked")
            Map<String, String> payload = (Map<String, String>) request.get("payload");

            // Validate input
            if (channel == null || channel.isBlank()) {
                Map<String, Object> errorResponse = new HashMap<>();
                errorResponse.put("success", false);
                errorResponse.put("error", "Channel name is required");
                return ResponseEntity.badRequest().body(errorResponse);
            }

            if (payload == null || payload.isEmpty()) {
                Map<String, Object> errorResponse = new HashMap<>();
                errorResponse.put("success", false);
                errorResponse.put("error", "Payload is required");
                return ResponseEntity.badRequest().body(errorResponse);
            }

            // Publish message
            long subscriberCount = pubSubService.publishMessage(channel, payload);

            // Build response
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("channel", channel);
            response.put("subscriberCount", subscriberCount);
            response.put("message", String.format("Message published to %d subscribers", subscriberCount));

            return ResponseEntity.ok(response);

        } catch (Exception e) {
            log.error("Error publishing message", e);

            Map<String, Object> errorResponse = new HashMap<>();
            errorResponse.put("success", false);
            errorResponse.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(errorResponse);
        }
    }

    /**
     * Health check endpoint.
     * 
     * @return Simple status response
     */
    @GetMapping("/health")
    public ResponseEntity<Map<String, Object>> health() {
        Map<String, Object> response = new HashMap<>();
        response.put("status", "UP");
        response.put("service", "PubSub");
        return ResponseEntity.ok(response);
    }
}

