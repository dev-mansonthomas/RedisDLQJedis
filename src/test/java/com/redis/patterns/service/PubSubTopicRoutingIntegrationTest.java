package com.redis.patterns.service;

import com.redis.patterns.config.RedisProperties;
import com.redis.patterns.support.AbstractRedisIntegrationTest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.function.BooleanSupplier;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Integration tests for Pub/Sub Topic Routing: {@code PSUBSCRIBE} patterns instead of a Lua router.
 *
 * <p>What distinguishes this from the stream version is that matching happens in Redis, at delivery
 * time, and a channel with no matching pattern is simply dropped — there is no exchange keeping an
 * audit trail. The counts returned by {@code PUBLISH} are the observable, so the tests assert how
 * many pattern subscribers a routing key reaches.
 *
 * <p>Spec: {@code docs/specs/pubsub-topic-routing.md}.
 */
class PubSubTopicRoutingIntegrationTest extends AbstractRedisIntegrationTest {

    private PubSubTopicRoutingService service;

    @BeforeEach
    void startService() throws Exception {
        RedisProperties properties = new RedisProperties();
        properties.setHost(REDIS_HOST);
        properties.setPort(redisPort);
        var objectMapper = new ObjectMapper();
        service = new PubSubTopicRoutingService(jedisPool, properties, objectMapper,
                                                new WebSocketEventService(objectMapper));
        service.initialize();
        // PSUBSCRIBE happens on background connections; nothing is routed until Redis knows about them.
        awaitTrue(() -> patternSubscriberCount() == 3, Duration.ofSeconds(10),
                  "the three pattern subscriptions to register");
    }

    @AfterEach
    void stopService() {
        if (service != null) {
            service.shutdown();
        }
    }

    @Test
    void theThreeDemoPatternsAreSubscribed() {
        assertThat(service.getActiveSubscriptions().values())
            .containsExactlyInAnyOrder(
                PubSubTopicRoutingService.EU_COMPLIANCE_PATTERN,
                PubSubTopicRoutingService.ORDER_AUDIT_PATTERN,
                PubSubTopicRoutingService.US_ORDERS_PATTERN);
    }

    @Test
    void aKeyCanMatchSeveralPatternsAtOnce() {
        // order.eu.created matches "order.eu.*" and "order.*.created", not "order.us.*"
        long receivers = service.publishMessage("order.eu.created", Map.of("orderId", "ORD-1"));

        assertThat(receivers)
            .as("EU compliance and Order audit both match; US orders does not")
            .isEqualTo(2);
    }

    @Test
    void aKeyCanMatchExactlyOnePattern() {
        // order.eu.cancelled matches only "order.eu.*" — "order.*.created" requires the created suffix
        assertThat(service.publishMessage("order.eu.cancelled", Map.of("orderId", "ORD-2")))
            .isEqualTo(1);

        // order.us.shipped matches only "order.us.*"
        assertThat(service.publishMessage("order.us.shipped", Map.of("orderId", "ORD-3")))
            .isEqualTo(1);
    }

    @Test
    void theUsKeyReachesTheUsAndAuditPatternsButNotTheEuOne() {
        assertThat(service.publishMessage("order.us.created", Map.of("orderId", "ORD-4")))
            .as("US orders + Order audit")
            .isEqualTo(2);
    }

    @Test
    void anUnmatchedKeyIsDroppedWithoutATrace() {
        long receivers = service.publishMessage("telemetry.heartbeat", Map.of("id", "1"));

        assertThat(receivers).isZero();
        try (var jedis = jedisPool.getResource()) {
            assertThat(jedis.dbSize())
                .as("unlike the stream router, Pub/Sub keeps no exchange entry for an unroutable key")
                .isZero();
        }
    }

    private long patternSubscriberCount() {
        try (var jedis = jedisPool.getResource()) {
            return jedis.pubsubNumPat();
        }
    }

    private void awaitTrue(BooleanSupplier condition, Duration timeout, String what) throws Exception {
        Instant deadline = Instant.now().plus(timeout);
        while (Instant.now().isBefore(deadline)) {
            if (condition.getAsBoolean()) {
                return;
            }
            Thread.sleep(100);
        }
        throw new AssertionError("Timed out waiting for " + what);
    }
}
