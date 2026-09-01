package com.redis.patterns.controller;

import com.redis.patterns.service.ScheduledMessagesService;
import com.redis.patterns.service.ScheduledMessagesService.ScheduledMessage;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * REST Controller for Scheduled/Delayed Messages pattern.
 */
@Slf4j
@RestController
@RequestMapping("/scheduled-messages")
@RequiredArgsConstructor
public class ScheduledMessagesController {

    private final ScheduledMessagesService scheduledMessagesService;

    /**
     * Get all scheduled messages.
     */
    @GetMapping
    public ResponseEntity<Map<String, Object>> getAllMessages() {
        Map<String, Object> response = new HashMap<>();
        try {
            List<ScheduledMessage> messages = scheduledMessagesService.getAllScheduledMessages();
            response.put("success", true);
            response.put("messages", messages);
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Failed to get scheduled messages", e);
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * Schedule a new message.
     */
    @PostMapping
    public ResponseEntity<Map<String, Object>> scheduleMessage(@RequestBody ScheduleRequest request) {
        Map<String, Object> response = new HashMap<>();
        try {
            // Validate that scheduledFor is in the future
            if (request.getScheduledFor() <= System.currentTimeMillis()) {
                response.put("success", false);
                response.put("error", "Scheduled time must be in the future");
                return ResponseEntity.badRequest().body(response);
            }

            ScheduledMessage message = scheduledMessagesService.scheduleMessage(
                request.getTitle(),
                request.getDescription(),
                request.getScheduledFor()
            );

            response.put("success", true);
            response.put("message", message);
            log.info("Scheduled message: {} for {}", message.getTitle(), message.getScheduledFor());
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Failed to schedule message", e);
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * Update an existing scheduled message.
     */
    @PutMapping("/{id}")
    public ResponseEntity<Map<String, Object>> updateMessage(
            @PathVariable String id,
            @RequestBody ScheduleRequest request) {
        Map<String, Object> response = new HashMap<>();
        try {
            // Validate that scheduledFor is in the future
            if (request.getScheduledFor() <= System.currentTimeMillis()) {
                response.put("success", false);
                response.put("error", "Scheduled time must be in the future");
                return ResponseEntity.badRequest().body(response);
            }

            ScheduledMessage message = scheduledMessagesService.updateMessage(
                id,
                request.getTitle(),
                request.getDescription(),
                request.getScheduledFor()
            );

            response.put("success", true);
            response.put("message", message);
            log.info("Updated message: {}", id);
            return ResponseEntity.ok(response);
        } catch (IllegalArgumentException e) {
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.notFound().build();
        } catch (Exception e) {
            log.error("Failed to update message", e);
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * Delete a scheduled message.
     */
    @DeleteMapping("/{id}")
    public ResponseEntity<Map<String, Object>> deleteMessage(@PathVariable String id) {
        Map<String, Object> response = new HashMap<>();
        try {
            scheduledMessagesService.deleteMessage(id);
            response.put("success", true);
            log.info("Deleted message: {}", id);
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Failed to delete message", e);
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * Clear all scheduled messages and reminders.
     */
    @DeleteMapping("/clear")
    public ResponseEntity<Map<String, Object>> clearAll() {
        Map<String, Object> response = new HashMap<>();
        try {
            scheduledMessagesService.clearAll();
            response.put("success", true);
            response.put("message", "All scheduled messages and reminders cleared");
            log.info("Cleared all scheduled messages");
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Failed to clear", e);
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * Get stream names.
     */
    @GetMapping("/streams")
    public ResponseEntity<Map<String, Object>> getStreams() {
        Map<String, Object> response = new HashMap<>();
        response.put("success", true);
        response.put("streams", scheduledMessagesService.getStreamNames());
        return ResponseEntity.ok(response);
    }

    // Request DTO
    @lombok.Data
    public static class ScheduleRequest {
        private String title;
        private String description;
        private long scheduledFor;
    }
}

