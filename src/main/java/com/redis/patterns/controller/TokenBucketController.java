package com.redis.patterns.controller;

import com.redis.patterns.service.TokenBucketService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * REST controller for Token Bucket pattern - dynamic concurrency control.
 */
@RestController
@RequestMapping("/token-bucket")
@RequiredArgsConstructor
public class TokenBucketController {

    private final TokenBucketService service;

    /**
     * Submit jobs of a specific type.
     */
    @PostMapping("/submit")
    public ResponseEntity<Map<String, Object>> submitJobs(@RequestBody Map<String, Object> request) {
        String type = (String) request.get("type");
        int count = (int) request.get("count");
        return ResponseEntity.ok(service.submitJobs(type, count));
    }

    /**
     * Get current configuration and running counts.
     */
    @GetMapping("/config")
    public ResponseEntity<Map<String, Object>> getConfig() {
        return ResponseEntity.ok(service.getConfig());
    }

    /**
     * Update max concurrency for a job type.
     */
    @PutMapping("/config")
    public ResponseEntity<Map<String, Object>> updateConfig(@RequestBody Map<String, Object> request) {
        String type = (String) request.get("type");
        int maxConcurrency = (int) request.get("maxConcurrency");
        return ResponseEntity.ok(service.updateConfig(type, maxConcurrency));
    }

    /**
     * Clear all streams and reset counters.
     */
    @DeleteMapping("/clear")
    public ResponseEntity<Map<String, Object>> clearStreams() {
        service.clearAllStreams();
        return ResponseEntity.ok(Map.of("success", true, "message", "All streams and counters cleared"));
    }

    /**
     * Get submission and completion logs.
     */
    @GetMapping("/logs")
    public ResponseEntity<Map<String, Object>> getLogs() {
        return ResponseEntity.ok(service.getLogs());
    }

    /**
     * Get current running counts per job type (for chart).
     */
    @GetMapping("/progress")
    public ResponseEntity<Map<String, Object>> getProgress() {
        return ResponseEntity.ok(service.getProgress());
    }
}

