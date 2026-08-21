package com.redis.patterns.service;

import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;
import lombok.Data;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.CommandLineRunner;
import org.springframework.context.annotation.Lazy;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Service;
import redis.clients.jedis.JedisPool;

import java.time.Instant;
import java.util.*;

/**
 * Service for managing dynamic routing rules stored in Redis.
 *
 * Provides CRUD operations for:
 * - Routing rules (pattern -> destination mappings)
 * - Routing metadata (maxRules, version, etc.)
 *
 * Rules are evaluated by the Lua function route_message at runtime.
 *
 * At startup:
 * - Clears all streams from demo services (Topic, FanOut, WorkQueue)
 * - Purges and reloads routing rules
 */
@Slf4j
@Service
@Order(4)
public class RoutingRulesService implements CommandLineRunner {

    private final JedisPool jedisPool;
    private final ObjectMapper objectMapper;
    private final TopicRoutingService topicRoutingService;
    private final FanOutService fanOutService;
    private final WorkQueueService workQueueService;
    private final DLQMessagingService dlqMessagingService;
    private final ContentBasedRoutingService contentBasedRoutingService;

    public static final String EXCHANGE_STREAM = "events.topic.v1";

    // Redis key patterns
    private static final String RULES_KEY_PREFIX = "routing:rules:";
    private static final String CONFIG_KEY_PREFIX = "routing:config:";

    public RoutingRulesService(JedisPool jedisPool, ObjectMapper objectMapper,
                               @Lazy TopicRoutingService topicRoutingService,
                               @Lazy FanOutService fanOutService,
                               @Lazy WorkQueueService workQueueService,
                               @Lazy DLQMessagingService dlqMessagingService,
                               @Lazy ContentBasedRoutingService contentBasedRoutingService) {
        this.jedisPool = jedisPool;
        this.objectMapper = objectMapper;
        this.topicRoutingService = topicRoutingService;
        this.fanOutService = fanOutService;
        this.workQueueService = workQueueService;
        this.dlqMessagingService = dlqMessagingService;
        this.contentBasedRoutingService = contentBasedRoutingService;
    }

    @Override
    public void run(String... args) throws Exception {
        clearAllDemoStreams();
        initializeDefaultRulesAndMetadata();
    }

    /**
     * Clear all streams from demo services at startup.
     */
    private void clearAllDemoStreams() {
        log.info("=".repeat(60));
        log.info("STARTUP: Clearing all demo streams");
        log.info("=".repeat(60));

        try {
            topicRoutingService.clearAllStreams();
            log.info("✓ Topic Routing streams cleared");
        } catch (Exception e) {
            log.warn("Could not clear Topic Routing streams: {}", e.getMessage());
        }

        try {
            fanOutService.clearAllStreams();
            log.info("✓ Fan-Out streams cleared");
        } catch (Exception e) {
            log.warn("Could not clear Fan-Out streams: {}", e.getMessage());
        }

        try {
            workQueueService.clearAllStreams();
            log.info("✓ Work Queue streams cleared");
        } catch (Exception e) {
            log.warn("Could not clear Work Queue streams: {}", e.getMessage());
        }

        try {
            dlqMessagingService.clearDLQStreams();
            log.info("✓ DLQ demo streams cleared");
        } catch (Exception e) {
            log.warn("Could not clear DLQ demo streams: {}", e.getMessage());
        }

        try {
            contentBasedRoutingService.clearAllStreams();
            log.info("✓ Content-Based Routing streams cleared");
        } catch (Exception e) {
            log.warn("Could not clear Content-Based Routing streams: {}", e.getMessage());
        }

        log.info("All demo streams cleared");
    }

    /**
     * Initialize default routing rules and metadata at startup.
     * Always purges and reloads rules to ensure consistency with code.
     */
    public void initializeDefaultRulesAndMetadata() {
        log.info("=".repeat(60));
        log.info("STARTUP: Loading routing rules for {}", EXCHANGE_STREAM);
        log.info("=".repeat(60));

        try (var jedis = jedisPool.getResource()) {
            String rulesKey = RULES_KEY_PREFIX + EXCHANGE_STREAM;
            String configKey = CONFIG_KEY_PREFIX + EXCHANGE_STREAM;

            // Purge existing rules and config to ensure fresh start
            jedis.del(rulesKey);
            jedis.del(configKey);
            log.info("Purged existing routing rules and config");

            // Initialize metadata
            Map<String, String> config = new HashMap<>();
            config.put("maxRules", "25");
            config.put("version", "1");
            config.put("updatedAt", Instant.now().toString());
            config.put("description", "Order Routing Demo - Multi-destination & Stop on Match");
            jedis.hset(configKey, config);

            // Initialize default rules for Order Routing use case
            List<RoutingRule> defaultRules = createDefaultRules();
            Map<String, String> rulesMap = new HashMap<>();

            log.info("-".repeat(60));
            log.info("Loading {} routing rules:", defaultRules.size());
            log.info("-".repeat(60));

            for (RoutingRule rule : defaultRules) {
                rulesMap.put(rule.getId(), toJson(rule));
                log.info("  [{}] Priority={} Pattern='{}' → {} {}",
                    rule.getId(),
                    rule.getPriority(),
                    rule.getPattern(),
                    rule.getDestination(),
                    rule.isStopOnMatch() ? "⛔ STOP" : "");
            }

            jedis.hset(rulesKey, rulesMap);
            log.info("-".repeat(60));
            log.info("✓ {} routing rules loaded successfully", defaultRules.size());
            log.info("=".repeat(60));
        }
    }

    /**
     * Create default rules demonstrating Order Routing use case.
     *
     * Routing Key Pattern: order.<action>.<customer_type>.<region>.v<version>
     * - action: place, cancelled
     * - customer_type: regular, vip
     * - region: us, eu
     * - version: v1, v2
     */
    private List<RoutingRule> createDefaultRules() {
        List<RoutingRule> rules = new ArrayList<>();

        // Rule 1: Cancelled orders → Audit ONLY (STOP ON MATCH)
        // Demonstrates: stopOnMatch prevents VIP/GDPR notifications for cancelled orders
        rules.add(new RoutingRule("001", "order%.cancelled%.", "events.audit.cancelled",
            "⛔ Cancelled orders → Audit ONLY (stops evaluation)", 1, true, true));

        // Rule 2-3: Version-aware routing (v1 vs v2 API)
        // Demonstrates: routing to different API versions
        rules.add(new RoutingRule("010", "%.v1$", "events.order.v1",
            "Version 1 API routing", 10, true, false));
        rules.add(new RoutingRule("011", "%.v2$", "events.order.v2",
            "Version 2 API routing", 10, true, false));

        // Rule 4: VIP notifications (multi-destination)
        // Demonstrates: VIP orders get extra notification in addition to version routing
        rules.add(new RoutingRule("020", "%.vip%.", "events.notification.vip",
            "VIP customers → Extra notification", 20, true, false));

        // Rule 5: EU GDPR compliance (multi-destination)
        // Demonstrates: EU orders get GDPR notification in addition to other routing
        rules.add(new RoutingRule("021", "%.eu%.", "events.notification.gdpr",
            "EU region → GDPR compliance notification", 20, true, false));

        return rules;
    }

    private String toJson(RoutingRule rule) {
        try {
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("pattern", rule.getPattern());
            map.put("destination", rule.getDestination());
            map.put("description", rule.getDescription());
            map.put("priority", rule.getPriority());
            map.put("enabled", rule.isEnabled());
            map.put("stopOnMatch", rule.isStopOnMatch());
            return objectMapper.writeValueAsString(map);
        } catch (JacksonException e) {
            throw new RuntimeException("Failed to serialize rule", e);
        }
    }

    // =========================================================================
    // CRUD Operations for Rules
    // =========================================================================

    /**
     * Get all routing rules for an exchange stream.
     */
    public List<RoutingRule> getAllRules(String exchangeStream) {
        try (var jedis = jedisPool.getResource()) {
            String rulesKey = RULES_KEY_PREFIX + exchangeStream;
            Map<String, String> rulesMap = jedis.hgetAll(rulesKey);

            List<RoutingRule> rules = new ArrayList<>();
            for (Map.Entry<String, String> entry : rulesMap.entrySet()) {
                try {
                    RoutingRule rule = parseRule(entry.getKey(), entry.getValue());
                    rules.add(rule);
                } catch (Exception e) {
                    log.warn("Failed to parse rule {}: {}", entry.getKey(), e.getMessage());
                }
            }

            // Sort by priority
            rules.sort(Comparator.comparingInt(RoutingRule::getPriority));
            return rules;
        }
    }

    /**
     * Get a specific routing rule by ID.
     */
    public Optional<RoutingRule> getRule(String exchangeStream, String ruleId) {
        try (var jedis = jedisPool.getResource()) {
            String rulesKey = RULES_KEY_PREFIX + exchangeStream;
            String ruleJson = jedis.hget(rulesKey, ruleId);

            if (ruleJson == null) {
                return Optional.empty();
            }

            return Optional.of(parseRule(ruleId, ruleJson));
        }
    }

    /**
     * Create or update a routing rule.
     */
    public RoutingRule saveRule(String exchangeStream, RoutingRule rule) {
        try (var jedis = jedisPool.getResource()) {
            String rulesKey = RULES_KEY_PREFIX + exchangeStream;
            String configKey = CONFIG_KEY_PREFIX + exchangeStream;

            jedis.hset(rulesKey, rule.getId(), toJson(rule));
            jedis.hset(configKey, "updatedAt", Instant.now().toString());

            log.info("Saved routing rule {} for {}", rule.getId(), exchangeStream);
            return rule;
        }
    }

    /**
     * Delete a routing rule by ID.
     */
    public boolean deleteRule(String exchangeStream, String ruleId) {
        try (var jedis = jedisPool.getResource()) {
            String rulesKey = RULES_KEY_PREFIX + exchangeStream;
            String configKey = CONFIG_KEY_PREFIX + exchangeStream;

            long deleted = jedis.hdel(rulesKey, ruleId);
            if (deleted > 0) {
                jedis.hset(configKey, "updatedAt", Instant.now().toString());
                log.info("Deleted routing rule {} from {}", ruleId, exchangeStream);
                return true;
            }
            return false;
        }
    }

    // =========================================================================
    // CRUD Operations for Metadata
    // =========================================================================

    /**
     * Get routing metadata for an exchange stream.
     */
    public RoutingMetadata getMetadata(String exchangeStream) {
        try (var jedis = jedisPool.getResource()) {
            String configKey = CONFIG_KEY_PREFIX + exchangeStream;
            Map<String, String> config = jedis.hgetAll(configKey);

            RoutingMetadata metadata = new RoutingMetadata();
            metadata.setExchangeStream(exchangeStream);
            metadata.setMaxRules(Integer.parseInt(config.getOrDefault("maxRules", "20")));
            metadata.setVersion(config.getOrDefault("version", "1"));
            metadata.setUpdatedAt(config.get("updatedAt"));
            metadata.setDescription(config.getOrDefault("description", ""));

            // Count rules
            String rulesKey = RULES_KEY_PREFIX + exchangeStream;
            metadata.setRuleCount((int) jedis.hlen(rulesKey));

            return metadata;
        }
    }

    /**
     * Update routing metadata.
     */
    public RoutingMetadata saveMetadata(String exchangeStream, RoutingMetadata metadata) {
        try (var jedis = jedisPool.getResource()) {
            String configKey = CONFIG_KEY_PREFIX + exchangeStream;

            Map<String, String> config = new HashMap<>();
            config.put("maxRules", String.valueOf(metadata.getMaxRules()));
            config.put("version", metadata.getVersion());
            config.put("description", metadata.getDescription());
            config.put("updatedAt", Instant.now().toString());

            jedis.hset(configKey, config);

            log.info("Updated metadata for {}", exchangeStream);
            return getMetadata(exchangeStream);
        }
    }

    /**
     * Reset all rules and metadata to defaults.
     */
    public void resetToDefaults(String exchangeStream) {
        try (var jedis = jedisPool.getResource()) {
            jedis.del(RULES_KEY_PREFIX + exchangeStream);
            jedis.del(CONFIG_KEY_PREFIX + exchangeStream);
        }
        initializeDefaultRulesAndMetadata();
    }

    private RoutingRule parseRule(String id, String json) {
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> map = objectMapper.readValue(json, Map.class);

            RoutingRule rule = new RoutingRule();
            rule.setId(id);
            rule.setPattern((String) map.get("pattern"));
            rule.setDestination((String) map.get("destination"));
            rule.setDescription((String) map.getOrDefault("description", ""));
            rule.setPriority(((Number) map.getOrDefault("priority", 100)).intValue());
            rule.setEnabled((Boolean) map.getOrDefault("enabled", true));
            rule.setStopOnMatch((Boolean) map.getOrDefault("stopOnMatch", false));

            return rule;
        } catch (JacksonException e) {
            throw new RuntimeException("Failed to parse rule JSON", e);
        }
    }

    // =========================================================================
    // DTOs
    // =========================================================================

    @Data
    public static class RoutingRule {
        private String id;
        private String pattern;
        private String destination;
        private String description;
        private int priority = 100;
        private boolean enabled = true;
        private boolean stopOnMatch = false;

        public RoutingRule() {}

        public RoutingRule(String id, String pattern, String destination,
                          String description, int priority, boolean enabled, boolean stopOnMatch) {
            this.id = id;
            this.pattern = pattern;
            this.destination = destination;
            this.description = description;
            this.priority = priority;
            this.enabled = enabled;
            this.stopOnMatch = stopOnMatch;
        }
    }

    @Data
    public static class RoutingMetadata {
        private String exchangeStream;
        private int maxRules = 20;
        private String version = "1";
        private String updatedAt;
        private String description;
        private int ruleCount;
    }
}

