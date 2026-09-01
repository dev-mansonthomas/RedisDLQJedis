package com.redis.patterns.controller;

import com.redis.patterns.service.FanOutService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/**
 * REST Controller for Fan-Out (Broadcast) pattern.
 * 
 * Endpoints:
 * - POST /api/fan-out/produce - Produce a single event (broadcast to all workers)
 * - GET /api/fan-out/streams - Get stream names for this pattern
 * - DELETE /api/fan-out/clear - Clear all streams and recreate consumer groups
 */
@Slf4j
@RestController
@RequestMapping("/fan-out")
@RequiredArgsConstructor
public class FanOutController {

    private final FanOutService fanOutService;

    /**
     * Produce a single event to the fan-out stream.
     * This event will be delivered to ALL workers (broadcast).
     * 
     * @param processingType "OK" for successful processing, "Error" for failed processing
     * @return Response with the produced message ID
     */
    @PostMapping("/produce")
    public ResponseEntity<Map<String, Object>> produceEvent(
            @RequestParam(defaultValue = "OK") String processingType) {
        
        Map<String, Object> response = new HashMap<>();
        
        try {
            String eventId = "EVT-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();
            String messageId = fanOutService.produceEvent(eventId, processingType, null);
            
            response.put("success", true);
            response.put("eventId", eventId);
            response.put("messageId", messageId);
            response.put("processingType", processingType);
            
            log.debug("Produced event {} (type={})", eventId, processingType);
            
            return ResponseEntity.ok(response);
            
        } catch (Exception e) {
            log.error("Failed to produce event", e);
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
        response.put("streams", fanOutService.getStreamNames());
        return ResponseEntity.ok(response);
    }

    /**
     * Clear all fan-out streams and recreate consumer groups.
     *
     * DELETE /api/fan-out/clear
     */
    @DeleteMapping("/clear")
    public ResponseEntity<Map<String, Object>> clearAllStreams() {
        Map<String, Object> response = new HashMap<>();

        try {
            fanOutService.clearAllStreams();

            response.put("success", true);
            response.put("message", "All streams cleared and consumer groups recreated");

            log.info("Fan-out streams cleared");

            return ResponseEntity.ok(response);

        } catch (Exception e) {
            log.error("Failed to clear fan-out streams", e);
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }
}

