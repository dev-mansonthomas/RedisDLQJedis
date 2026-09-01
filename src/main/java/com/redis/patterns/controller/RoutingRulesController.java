package com.redis.patterns.controller;

import com.redis.patterns.service.RoutingRulesService;
import com.redis.patterns.service.RoutingRulesService.RoutingRule;
import com.redis.patterns.service.RoutingRulesService.RoutingMetadata;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * REST Controller for managing dynamic routing rules.
 * 
 * Provides CRUD operations for:
 * - Routing rules (patterns that determine where messages go)
 * - Routing metadata (configuration like maxRules)
 */
@Slf4j
@RestController
@RequestMapping("/routing-rules")
@RequiredArgsConstructor
public class RoutingRulesController {

    private final RoutingRulesService routingRulesService;

    /** Maximum accepted length of a routing rule's Lua pattern (basic write-time guard). */
    private static final int MAX_PATTERN_LENGTH = 200;

    // =========================================================================
    // Rules CRUD Endpoints
    // =========================================================================

    /**
     * Get all routing rules for an exchange stream.
     * GET /api/routing-rules/{exchangeStream}/rules
     */
    @GetMapping("/{exchangeStream}/rules")
    public ResponseEntity<Map<String, Object>> getAllRules(
            @PathVariable String exchangeStream) {
        
        Map<String, Object> response = new HashMap<>();
        try {
            List<RoutingRule> rules = routingRulesService.getAllRules(exchangeStream);
            response.put("success", true);
            response.put("exchangeStream", exchangeStream);
            response.put("rules", rules);
            response.put("count", rules.size());
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Failed to get rules for {}", exchangeStream, e);
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * Get a specific routing rule.
     * GET /api/routing-rules/{exchangeStream}/rules/{ruleId}
     */
    @GetMapping("/{exchangeStream}/rules/{ruleId}")
    public ResponseEntity<Map<String, Object>> getRule(
            @PathVariable String exchangeStream,
            @PathVariable String ruleId) {
        
        Map<String, Object> response = new HashMap<>();
        try {
            Optional<RoutingRule> rule = routingRulesService.getRule(exchangeStream, ruleId);
            if (rule.isPresent()) {
                response.put("success", true);
                response.put("rule", rule.get());
                return ResponseEntity.ok(response);
            } else {
                response.put("success", false);
                response.put("error", "Rule not found: " + ruleId);
                return ResponseEntity.notFound().build();
            }
        } catch (Exception e) {
            log.error("Failed to get rule {} for {}", ruleId, exchangeStream, e);
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * Create or update a routing rule.
     * POST /api/routing-rules/{exchangeStream}/rules
     */
    @PostMapping("/{exchangeStream}/rules")
    public ResponseEntity<Map<String, Object>> saveRule(
            @PathVariable String exchangeStream,
            @RequestBody RoutingRule rule) {
        
        Map<String, Object> response = new HashMap<>();
        try {
            // Validate required fields
            if (rule.getId() == null || rule.getId().isBlank()) {
                response.put("success", false);
                response.put("error", "Rule ID is required");
                return ResponseEntity.badRequest().body(response);
            }
            if (rule.getPattern() == null || rule.getPattern().isBlank()) {
                response.put("success", false);
                response.put("error", "Pattern is required");
                return ResponseEntity.badRequest().body(response);
            }
            // Basic write-time guard against absurd patterns. We cannot compile a Lua
            // pattern in Java, so the real safety net is the pcall in route_message;
            // this just rejects obviously malicious/oversized input early.
            if (rule.getPattern().length() > MAX_PATTERN_LENGTH) {
                response.put("success", false);
                response.put("error", "Pattern is too long (max " + MAX_PATTERN_LENGTH + " chars)");
                return ResponseEntity.badRequest().body(response);
            }
            if (rule.getDestination() == null || rule.getDestination().isBlank()) {
                response.put("success", false);
                response.put("error", "Destination is required");
                return ResponseEntity.badRequest().body(response);
            }

            RoutingRule saved = routingRulesService.saveRule(exchangeStream, rule);
            response.put("success", true);
            response.put("rule", saved);
            response.put("message", "Rule saved successfully");
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Failed to save rule for {}", exchangeStream, e);
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * Delete a routing rule.
     * DELETE /api/routing-rules/{exchangeStream}/rules/{ruleId}
     */
    @DeleteMapping("/{exchangeStream}/rules/{ruleId}")
    public ResponseEntity<Map<String, Object>> deleteRule(
            @PathVariable String exchangeStream,
            @PathVariable String ruleId) {

        Map<String, Object> response = new HashMap<>();
        try {
            boolean deleted = routingRulesService.deleteRule(exchangeStream, ruleId);
            if (deleted) {
                response.put("success", true);
                response.put("message", "Rule deleted successfully");
                return ResponseEntity.ok(response);
            } else {
                response.put("success", false);
                response.put("error", "Rule not found: " + ruleId);
                return ResponseEntity.notFound().build();
            }
        } catch (Exception e) {
            log.error("Failed to delete rule {} for {}", ruleId, exchangeStream, e);
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    // =========================================================================
    // Metadata Endpoints
    // =========================================================================

    /**
     * Get routing metadata for an exchange stream.
     * GET /api/routing-rules/{exchangeStream}/metadata
     */
    @GetMapping("/{exchangeStream}/metadata")
    public ResponseEntity<Map<String, Object>> getMetadata(
            @PathVariable String exchangeStream) {

        Map<String, Object> response = new HashMap<>();
        try {
            RoutingMetadata metadata = routingRulesService.getMetadata(exchangeStream);
            response.put("success", true);
            response.put("metadata", metadata);
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Failed to get metadata for {}", exchangeStream, e);
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * Update routing metadata.
     * PUT /api/routing-rules/{exchangeStream}/metadata
     */
    @PutMapping("/{exchangeStream}/metadata")
    public ResponseEntity<Map<String, Object>> updateMetadata(
            @PathVariable String exchangeStream,
            @RequestBody RoutingMetadata metadata) {

        Map<String, Object> response = new HashMap<>();
        try {
            RoutingMetadata saved = routingRulesService.saveMetadata(exchangeStream, metadata);
            response.put("success", true);
            response.put("metadata", saved);
            response.put("message", "Metadata updated successfully");
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Failed to update metadata for {}", exchangeStream, e);
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * Reset all rules and metadata to defaults.
     * POST /api/routing-rules/{exchangeStream}/reset
     */
    @PostMapping("/{exchangeStream}/reset")
    public ResponseEntity<Map<String, Object>> resetToDefaults(
            @PathVariable String exchangeStream) {

        Map<String, Object> response = new HashMap<>();
        try {
            routingRulesService.resetToDefaults(exchangeStream);

            // Return the new state
            List<RoutingRule> rules = routingRulesService.getAllRules(exchangeStream);
            RoutingMetadata metadata = routingRulesService.getMetadata(exchangeStream);

            response.put("success", true);
            response.put("message", "Reset to defaults completed");
            response.put("rules", rules);
            response.put("metadata", metadata);
            return ResponseEntity.ok(response);
        } catch (Exception e) {
            log.error("Failed to reset rules for {}", exchangeStream, e);
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }
}

