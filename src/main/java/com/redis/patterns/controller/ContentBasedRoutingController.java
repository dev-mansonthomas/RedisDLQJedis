package com.redis.patterns.controller;

import com.redis.patterns.service.ContentBasedRoutingService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * REST Controller for Content-Based Routing pattern.
 * Routes payments based on their content (amount) to different streams.
 */
@Slf4j
@RestController
@RequestMapping("/content-routing")
@RequiredArgsConstructor
public class ContentBasedRoutingController {

    private final ContentBasedRoutingService routingService;

    /**
     * Submit a payment to be routed based on its content.
     */
    @PostMapping("/submit")
    public ResponseEntity<Map<String, Object>> submitPayment(@RequestBody PaymentRequest request) {
        Map<String, Object> response = new HashMap<>();
        
        try {
            String paymentId = request.paymentId != null ? request.paymentId 
                : "PAY-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
            
            String messageId = routingService.submitPayment(
                paymentId, 
                request.amount, 
                request.country != null ? request.country : "US",
                request.method != null ? request.method : "card"
            );
            
            String targetStream = routingService.determineTargetStream(request.amount);
            
            response.put("success", true);
            response.put("paymentId", paymentId);
            response.put("messageId", messageId);
            response.put("amount", request.amount);
            response.put("willRouteTo", targetStream);
            
            log.debug("Submitted payment {} (amount={}) -> {}", paymentId, request.amount, targetStream);
            
            return ResponseEntity.ok(response);
            
        } catch (Exception e) {
            log.error("Failed to submit payment", e);
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * Get routing rules for display in the UI.
     */
    @GetMapping("/rules")
    public ResponseEntity<Map<String, Object>> getRoutingRules() {
        Map<String, Object> response = new HashMap<>();
        response.put("success", true);
        response.put("rules", routingService.getRoutingRules());
        return ResponseEntity.ok(response);
    }

    /**
     * Get stream names used by this pattern.
     */
    @GetMapping("/streams")
    public ResponseEntity<Map<String, Object>> getStreams() {
        Map<String, Object> response = new HashMap<>();
        response.put("success", true);
        response.put("streams", routingService.getStreamNames());
        return ResponseEntity.ok(response);
    }

    /**
     * Clear all streams and recreate consumer group.
     */
    @DeleteMapping("/clear")
    public ResponseEntity<Map<String, Object>> clearAllStreams() {
        Map<String, Object> response = new HashMap<>();
        
        try {
            routingService.clearAllStreams();
            response.put("success", true);
            response.put("message", "All content-based routing streams cleared");
            log.info("Content-based routing streams cleared");
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Failed to clear streams", e);
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * DTO for payment submission request.
     */
    public static class PaymentRequest {
        public String paymentId;
        public double amount;
        public String country;
        public String method;
    }
}

