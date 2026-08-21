package com.redis.patterns.service;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import com.redis.patterns.config.RedisProperties;
import com.redis.patterns.dto.PubSubEvent;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import redis.clients.jedis.Jedis;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.JedisPubSub;

import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@Slf4j
@Service
public class PubSubTopicRoutingService {

    private final JedisPool jedisPool;
    private final RedisProperties redisProperties;
    private final ObjectMapper objectMapper;
    private final WebSocketEventService webSocketEventService;
    private final Map<String, PatternSubscriber> activeSubscriptions = new ConcurrentHashMap<>();
    private final ExecutorService executorService = Executors.newCachedThreadPool();

    public static final String EU_COMPLIANCE_PATTERN = "order.eu.*";
    public static final String ORDER_AUDIT_PATTERN = "order.*.created";
    public static final String US_ORDERS_PATTERN = "order.us.*";

    /**
     * Backoff between reconnect attempts when a subscription drops (milliseconds).
     */
    private static final long RECONNECT_BACKOFF_MILLIS = 1000;

    public PubSubTopicRoutingService(JedisPool jedisPool,
                                     RedisProperties redisProperties,
                                     ObjectMapper objectMapper,
                                     WebSocketEventService webSocketEventService) {
        this.jedisPool = jedisPool;
        this.redisProperties = redisProperties;
        this.objectMapper = objectMapper;
        this.webSocketEventService = webSocketEventService;
    }

    @PostConstruct
    public void initialize() {
        log.info("Initializing PubSubTopicRoutingService with pattern subscriptions...");
        subscribeToPattern("EU Compliance", EU_COMPLIANCE_PATTERN);
        subscribeToPattern("Order Audit", ORDER_AUDIT_PATTERN);
        subscribeToPattern("US Orders", US_ORDERS_PATTERN);
    }

    @PreDestroy
    public void shutdown() {
        log.info("Shutting down PubSubTopicRoutingService...");
        activeSubscriptions.values().forEach(PatternSubscriber::stop);
        executorService.shutdownNow();
    }

    public long publishMessage(String routingKey, Map<String, String> payload) {
        log.info("Publishing message to routing key '{}': {}", routingKey, payload);
        try (var jedis = jedisPool.getResource()) {
            String message = serializePayload(payload);
            long subscriberCount = jedis.publish(routingKey, message);
            log.info("Message published to {} subscribers on '{}'", subscriberCount, routingKey);
            webSocketEventService.broadcastEvent(PubSubEvent.builder()
                .eventType(PubSubEvent.EventType.MESSAGE_PUBLISHED)
                .channel(routingKey)
                .payload(payload)
                .details(String.format("Published to %d pattern subscribers", subscriberCount))
                .build());
            return subscriberCount;
        } catch (Exception e) {
            log.error("Failed to publish message to '{}'", routingKey, e);
            throw new RuntimeException("Failed to publish message", e);
        }
    }

    public void subscribeToPattern(String subscriberName, String pattern) {
        if (activeSubscriptions.containsKey(subscriberName)) {
            log.warn("Subscriber '{}' already active", subscriberName);
            return;
        }
        PatternSubscriber subscriber = new PatternSubscriber(subscriberName, pattern);
        activeSubscriptions.put(subscriberName, subscriber);
        executorService.submit(() -> {
            log.info("Starting pattern subscription '{}' -> '{}'", subscriberName, pattern);
            // Blocking PSUBSCRIBE on a DEDICATED connection (not pooled), wrapped in a
            // reconnect loop so a dropped connection is retried instead of stopping delivery.
            while (subscriber.isRunning()) {
                Jedis jedis = null;
                try {
                    jedis = createDedicatedConnection();
                    jedis.psubscribe(subscriber, pattern);
                } catch (Exception e) {
                    if (subscriber.isRunning()) {
                        log.warn("Pattern subscription '{}' connection lost, reconnecting in {}ms: {}",
                                subscriberName, RECONNECT_BACKOFF_MILLIS, e.getMessage());
                        sleepBackoff(subscriber);
                    }
                } finally {
                    if (jedis != null) {
                        jedis.close();
                    }
                }
            }
            activeSubscriptions.remove(subscriberName);
        });
    }

    public Map<String, String> getActiveSubscriptions() {
        Map<String, String> result = new ConcurrentHashMap<>();
        activeSubscriptions.forEach((name, sub) -> result.put(name, sub.getPattern()));
        return result;
    }

    /**
     * Builds a dedicated (non-pooled) Jedis connection from {@link RedisProperties}.
     * Authenticates only when a password is configured.
     */
    private Jedis createDedicatedConnection() {
        Jedis jedis = new Jedis(redisProperties.getHost(), redisProperties.getPort());
        String password = redisProperties.getPassword();
        if (password != null && !password.isEmpty()) {
            jedis.auth(password);
        }
        return jedis;
    }

    private void sleepBackoff(PatternSubscriber subscriber) {
        try {
            Thread.sleep(RECONNECT_BACKOFF_MILLIS);
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            subscriber.stop();
        }
    }

    /**
     * Serializes the payload map to a JSON string. JSON avoids the corruption that the
     * previous {@code key=value,key=value} format suffered when a value contained ',' or '='.
     */
    private String serializePayload(Map<String, String> payload) {
        if (payload == null || payload.isEmpty()) return "{}";
        try {
            return objectMapper.writeValueAsString(payload);
        } catch (Exception e) {
            log.error("Failed to serialize payload, falling back to empty object", e);
            return "{}";
        }
    }

    /**
     * Parses a JSON object string back into a payload map.
     */
    private Map<String, String> deserializePayload(String message) {
        Map<String, String> payload = new ConcurrentHashMap<>();
        if (message == null || message.isEmpty()) return payload;
        try {
            Map<String, String> parsed = objectMapper.readValue(message, new TypeReference<LinkedHashMap<String, String>>() {});
            if (parsed != null) {
                parsed.forEach((k, v) -> payload.put(k, v == null ? "" : v));
            }
        } catch (Exception e) {
            log.warn("Failed to parse JSON payload '{}': {}", message, e.getMessage());
        }
        return payload;
    }

    private class PatternSubscriber extends JedisPubSub {
        private final String subscriberName;
        private final String pattern;
        private volatile boolean running = true;

        public PatternSubscriber(String subscriberName, String pattern) {
            this.subscriberName = subscriberName;
            this.pattern = pattern;
        }

        public String getPattern() { return pattern; }
        public boolean isRunning() { return running; }
        public boolean isStopped() { return !running; }

        public void stop() {
            this.running = false;
            // Guard punsubscribe() so we don't hit "JedisPubSub is not subscribed"
            // when the subscription never established (or already dropped).
            try {
                if (isSubscribed()) {
                    this.punsubscribe();
                }
            } catch (Exception e) {
                log.debug("[{}] Error while unsubscribing during stop: {}", subscriberName, e.getMessage());
            }
        }

        @Override
        public void onPMessage(String pattern, String channel, String message) {
            log.info("[{}] Received on '{}' (pattern: '{}')", subscriberName, channel, pattern);
            Map<String, String> payload = deserializePayload(message);
            payload.put("_subscriber", subscriberName);
            payload.put("_pattern", pattern);
            payload.put("_channel", channel);
            webSocketEventService.broadcastEvent(PubSubEvent.builder()
                .eventType(PubSubEvent.EventType.MESSAGE_RECEIVED)
                .channel(channel)
                .payload(payload)
                .details(String.format("Received by '%s' (pattern: %s)", subscriberName, pattern))
                .build());
        }

        @Override
        public void onPSubscribe(String pattern, int subscribedChannels) {
            log.info("[{}] Subscribed to pattern '{}' (total: {})", subscriberName, pattern, subscribedChannels);
        }

        @Override
        public void onPUnsubscribe(String pattern, int subscribedChannels) {
            log.info("[{}] Unsubscribed from '{}' (remaining: {})", subscriberName, pattern, subscribedChannels);
        }
    }
}
