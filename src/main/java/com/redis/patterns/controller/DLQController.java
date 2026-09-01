package com.redis.patterns.controller;

import com.redis.patterns.dto.DLQConfigRequest;
import com.redis.patterns.dto.DLQParameters;
import com.redis.patterns.dto.DLQResponse;
import com.redis.patterns.dto.ProcessOutcome;
import com.redis.patterns.service.DLQConfigService;
import com.redis.patterns.service.DLQMessagingService;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.Map;

/**
 * REST Controller for DLQ operations.
 * 
 * This controller provides HTTP endpoints for:
 * - Executing DLQ operations (claim_or_dlq)
 * - Managing streams and consumer groups
 * - Running test scenarios
 * - Monitoring system status
 * 
 * All endpoints return structured JSON responses and handle errors gracefully.
 * 
 * @author Redis Patterns Team
 */
@Slf4j
@RestController
@RequestMapping("/dlq")
@RequiredArgsConstructor
public class DLQController {

    private final DLQMessagingService dlqMessagingService;
    private final DLQConfigService dlqConfigService;

    /**
     * Executes the claim_or_dlq operation with the provided parameters.
     * 
     * POST /api/dlq/claim
     * 
     * @param params DLQ parameters
     * @return Response containing operation results
     */
    @PostMapping("/claim")
    public ResponseEntity<DLQResponse> claimOrDLQ(@Valid @RequestBody DLQParameters params) {
        log.info("Received claim_or_dlq request: {}", params);
        
        try {
            DLQResponse response = dlqMessagingService.claimOrDLQ(params);
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Error executing claim_or_dlq", e);
            return ResponseEntity.internalServerError()
                .body(DLQResponse.builder()
                    .success(false)
                    .errorMessage(e.getMessage())
                    .build());
        }
    }

    /**
     * Initializes the consumer group for a stream.
     * 
     * POST /api/dlq/init
     * 
     * @param params DLQ parameters containing stream and group names
     * @return Success response
     */
    @PostMapping("/init")
    public ResponseEntity<Map<String, Object>> initializeConsumerGroup(
            @Valid @RequestBody DLQParameters params) {
        log.info("Initializing consumer group: {}", params.getConsumerGroup());
        
        try {
            dlqMessagingService.initializeConsumerGroup(
                params.getStreamName(), 
                params.getConsumerGroup()
            );
            
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("message", "Consumer group initialized");
            response.put("streamName", params.getStreamName());
            response.put("consumerGroup", params.getConsumerGroup());
            
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Error initializing consumer group", e);
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * Produces a test message to the stream.
     * 
     * POST /api/dlq/produce
     * 
     * @param request Request containing stream name and message payload
     * @return Response with message ID
     */
    @PostMapping("/produce")
    public ResponseEntity<Map<String, Object>> produceMessage(
            @RequestBody Map<String, Object> request) {
        String streamName = (String) request.get("streamName");
        @SuppressWarnings("unchecked")
        Map<String, String> payload = (Map<String, String>) request.get("payload");
        
        log.info("Producing message to stream: {}", streamName);
        
        try {
            String messageId = dlqMessagingService.produceMessage(streamName, payload);
            
            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("messageId", messageId);
            response.put("streamName", streamName);
            
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Error producing message", e);
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * Gets statistics about the streams.
     *
     * GET /api/dlq/stats?streamName=xxx&dlqStreamName=yyy&groupName=zzz
     *
     * @param streamName Main stream name
     * @param dlqStreamName DLQ stream name
     * @param groupName Consumer group name
     * @return Statistics map
     */
    @GetMapping("/stats")
    public ResponseEntity<Map<String, Object>> getStats(
            @RequestParam String streamName,
            @RequestParam String dlqStreamName,
            @RequestParam String groupName) {

        log.debug("Getting stats for stream: {}", streamName);

        try {
            Map<String, Object> stats = new HashMap<>();
            stats.put("streamLength", dlqMessagingService.getStreamLength(streamName));
            stats.put("dlqLength", dlqMessagingService.getStreamLength(dlqStreamName));
            stats.put("pendingCount", dlqMessagingService.getPendingCount(streamName, groupName));
            stats.put("success", true);

            return ResponseEntity.ok(stats);
        } catch (Exception e) {
            log.error("Error getting stats", e);
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * Reads messages from a stream.
     *
     * GET /api/dlq/messages?streamName=xxx&count=10
     *
     * @param streamName Stream name to read from
     * @param count Number of messages to read (default: 10)
     * @return List of messages
     */
    @GetMapping("/messages")
    public ResponseEntity<Map<String, Object>> getMessages(
            @RequestParam String streamName,
            @RequestParam(defaultValue = "10") int count) {

        log.debug("Reading {} messages from stream: {}", count, streamName);

        try {
            var messages = dlqMessagingService.readMessages(streamName, count);

            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("streamName", streamName);
            response.put("messages", messages);
            response.put("count", messages.size());
            // The size of the page cannot reveal that the page was truncated: a viewer holding 5 of 11
            // entries was told the stream held 5 and rendered "5 of 5 messages". XLEN is O(1).
            response.put("streamLength", dlqMessagingService.getStreamLength(streamName));

            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Error reading messages from stream: {}", streamName, e);
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * Get pending messages for a consumer group.
     *
     * GET /api/dlq/pending-messages?streamName=xxx&groupName=xxx&count=10
     *
     * @param streamName Stream name
     * @param groupName Consumer group name
     * @param count Number of pending messages to retrieve (default: 10)
     * @return List of pending messages
     */
    @GetMapping("/pending-messages")
    public ResponseEntity<Map<String, Object>> getPendingMessages(
            @RequestParam String streamName,
            @RequestParam String groupName,
            @RequestParam(defaultValue = "10") int count) {

        log.debug("Getting {} pending messages for stream: {}, group: {}", count, streamName, groupName);

        try {
            var messages = dlqMessagingService.getPendingMessages(streamName, groupName, count);

            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("streamName", streamName);
            response.put("messages", messages);
            response.put("count", messages.size());

            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Error getting pending messages", e);
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }



    /**
     * Get the next message ID that will be processed (oldest pending message).
     *
     * GET /api/dlq/next-message?streamName=xxx&groupName=xxx
     *
     * @param streamName Stream name
     * @param groupName Consumer group name
     * @return Response with next message ID or null if no pending messages
     */
    @GetMapping("/next-message")
    public ResponseEntity<Map<String, Object>> getNextMessage(
            @RequestParam String streamName,
            @RequestParam String groupName) {

        log.debug("Getting next message for stream: {}, group: {}", streamName, groupName);

        try {
            String nextMessageId = dlqMessagingService.getNextPendingMessageId(streamName, groupName);

            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("nextMessageId", nextMessageId);

            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Error getting next message", e);
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * Cleans up streams for testing.
     *
     * DELETE /api/dlq/cleanup
     *
     * @param streamName Main stream name
     * @param dlqStreamName DLQ stream name
     * @return Success response
     */
    @DeleteMapping("/cleanup")
    public ResponseEntity<Map<String, Object>> cleanup(
            @RequestParam String streamName,
            @RequestParam String dlqStreamName) {
        log.info("Cleaning up streams: {}, {}", streamName, dlqStreamName);

        try {
            dlqMessagingService.cleanup(streamName, dlqStreamName);

            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("message", "Streams cleaned up");

            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Error cleaning up streams", e);
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * Save DLQ configuration including maxDeliveries (maxRetry).
     *
     * POST /api/dlq/config
     *
     * @param config DLQ configuration request
     * @return Success response
     */
    @PostMapping("/config")
    public ResponseEntity<Map<String, Object>> saveConfig(@Valid @RequestBody DLQConfigRequest config) {
        log.info("Saving DLQ configuration: {}", config);

        try {
            dlqConfigService.saveConfiguration(config);

            Map<String, Object> response = new HashMap<>();
            response.put("success", true);
            response.put("message", "Configuration saved successfully");
            response.put("maxDeliveries", config.getMaxDeliveries());

            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Error saving configuration", e);
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * Get DLQ configuration for a specific stream.
     *
     * GET /api/dlq/config?streamName=test-stream
     *
     * @param streamName Stream name
     * @return Configuration
     */
    @GetMapping("/config")
    public ResponseEntity<DLQConfigRequest> getConfig(@RequestParam String streamName) {
        log.info("Getting DLQ configuration for stream: {}", streamName);
        DLQConfigRequest config = dlqConfigService.getConfiguration(streamName);
        return ResponseEntity.ok(config);
    }

    /**
     * Get all DLQ configurations.
     *
     * GET /api/dlq/config/all
     *
     * @return All configurations
     */
    @GetMapping("/config/all")
    public ResponseEntity<Map<String, DLQConfigRequest>> getAllConfigs() {
        log.info("Getting all DLQ configurations");
        return ResponseEntity.ok(dlqConfigService.getAllConfigurations());
    }

    /**
     * Process a single message with success or failure simulation.
     *
     * POST /api/dlq/process
     *
     * @param request Request containing shouldSucceed flag
     * @return Response with processing result
     */
    @PostMapping("/process")
    public ResponseEntity<Map<String, Object>> processMessage(@RequestBody Map<String, Object> request) {
        // Canonical body: {"outcome": ACK|NO_ACK|NACK_FAIL|NACK_FATAL|NACK_SILENT}.
        // Legacy body {"shouldSucceed": bool} still maps to ACK/NO_ACK.
        ProcessOutcome outcome;
        Object rawOutcome = request.get("outcome");
        if (rawOutcome != null) {
            try {
                outcome = ProcessOutcome.valueOf(rawOutcome.toString());
            } catch (IllegalArgumentException e) {
                log.warn("Rejected /process request with invalid outcome '{}'", rawOutcome);
                Map<String, Object> response = new HashMap<>();
                response.put("success", false);
                response.put("message", "Invalid outcome: " + rawOutcome);
                return ResponseEntity.badRequest().body(response);
            }
        } else {
            outcome = ProcessOutcome.fromLegacy((Boolean) request.getOrDefault("shouldSucceed", true));
        }

        log.info("Processing message with outcome={}", outcome);

        try {
            Map<String, Object> result = dlqMessagingService.processNextMessage(outcome);
            return ResponseEntity.ok(result);
        } catch (Exception e) {
            log.error("Error processing message", e);
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("message", "Error: " + e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * Deletes a stream.
     *
     * DELETE /api/dlq/stream/{streamName}
     *
     * @param streamName Name of the stream to delete
     * @return Response indicating success or failure
     */
    @DeleteMapping("/stream/{streamName}")
    public ResponseEntity<Map<String, Object>> deleteStream(@PathVariable String streamName) {
        log.info("Deleting stream: {}", streamName);

        try {
            boolean deleted = dlqMessagingService.deleteStream(streamName);

            Map<String, Object> response = new HashMap<>();
            response.put("success", deleted);
            response.put("streamName", streamName);
            response.put("message", deleted ? "Stream deleted successfully" : "Stream does not exist");

            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Error deleting stream '{}'", streamName, e);
            Map<String, Object> response = new HashMap<>();
            response.put("success", false);
            response.put("streamName", streamName);
            response.put("message", "Error: " + e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }
}

