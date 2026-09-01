package com.redis.patterns.controller;

import com.redis.patterns.service.PerKeySerializedService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * REST controller for Per-Key Serialized Processing pattern.
 */
@RestController
@RequestMapping("/per-key-serialized")
@RequiredArgsConstructor
public class PerKeySerializedController {

    private final PerKeySerializedService service;

    /**
     * Submit multiple jobs to the job stream.
     */
    @PostMapping("/submit")
    public ResponseEntity<Map<String, Object>> submitJobs(@RequestBody List<Map<String, String>> jobs) {
        return ResponseEntity.ok(service.submitJobs(jobs));
    }

    /**
     * Clear all streams.
     */
    @DeleteMapping("/clear")
    public ResponseEntity<Map<String, Object>> clearStreams() {
        service.clearAllStreams();
        return ResponseEntity.ok(Map.of("success", true, "message", "All streams cleared"));
    }
}

