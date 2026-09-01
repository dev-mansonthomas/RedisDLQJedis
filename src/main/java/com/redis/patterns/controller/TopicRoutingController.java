package com.redis.patterns.controller;

import com.redis.patterns.service.TopicRoutingService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * REST Controller for Topic Routing pattern.
 * 
 * Endpoints:
 * - POST /api/topic-routing/route - Route a message based on routing key
 * - GET /api/topic-routing/streams - Get stream names
 * - GET /api/topic-routing/routing-keys - Get available routing keys
 * - DELETE /api/topic-routing/clear - Clear all streams
 */
@Slf4j
@RestController
@RequestMapping("/topic-routing")
@RequiredArgsConstructor
public class TopicRoutingController {

    private final TopicRoutingService topicRoutingService;

    /**
     * Route a message to appropriate streams based on routing key.
     * 
     * POST /api/topic-routing/route?routingKey=order.created
     * 
     * @param routingKey The routing key (e.g., "order.created", "inventory.reserved")
     * @return Routing result with exchange ID and routed streams
     */
    @PostMapping("/route")
    public ResponseEntity<Map<String, Object>> routeMessage(
            @RequestParam String routingKey) {
        
        Map<String, Object> response = new HashMap<>();
        
        try {
            String eventId = "EVT-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
            
            TopicRoutingService.RoutingResult result = topicRoutingService.routeMessage(
                routingKey, eventId, null);
            
            response.put("success", true);
            response.put("eventId", eventId);
            response.put("routingKey", routingKey);
            response.put("exchangeId", result.getExchangeId());
            response.put("routedTo", result.getRoutedTo());
            
            log.debug("Routed message {} with key '{}' to {} streams", 
                eventId, routingKey, result.getRoutedTo().size());
            
            return ResponseEntity.ok(response);
            
        } catch (Exception e) {
            log.error("Failed to route message with key '{}'", routingKey, e);
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * Get stream names used by this pattern.
     */
    @GetMapping("/streams")
    public ResponseEntity<Map<String, Object>> getStreams() {
        Map<String, Object> response = new HashMap<>();
        response.put("success", true);
        response.put("streams", topicRoutingService.getStreamNames());
        return ResponseEntity.ok(response);
    }

    /**
     * Get available routing keys.
     */
    @GetMapping("/routing-keys")
    public ResponseEntity<Map<String, Object>> getRoutingKeys() {
        Map<String, Object> response = new HashMap<>();
        response.put("success", true);
        response.put("routingKeys", topicRoutingService.getAvailableRoutingKeys());
        return ResponseEntity.ok(response);
    }

    /**
     * Clear all topic routing streams.
     */
    @DeleteMapping("/clear")
    public ResponseEntity<Map<String, Object>> clearAllStreams() {
        Map<String, Object> response = new HashMap<>();

        try {
            topicRoutingService.clearAllStreams();

            response.put("success", true);
            response.put("message", "All streams cleared");

            log.info("Topic routing streams cleared");

            return ResponseEntity.ok(response);

        } catch (Exception e) {
            log.error("Failed to clear topic routing streams", e);
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }
}

