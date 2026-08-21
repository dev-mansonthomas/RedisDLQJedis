package com.redis.patterns.service;

import com.redis.patterns.support.AbstractRedisIntegrationTest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import redis.clients.jedis.StreamEntryID;
import tools.jackson.databind.ObjectMapper;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Integration tests for stream Topic Routing — the Lua {@code route_message} function fanning one
 * exchange entry out to the destinations whose rules match its routing key.
 *
 * <p>Rules live in Redis (`routing:rules:{exchange}`), so the interesting behaviours are not "does a
 * pattern match" but the two that a reader gets wrong: a key can match <em>several</em> rules and
 * land in several streams, and {@code stopOnMatch} truncates evaluation by priority order.
 *
 * <p>Spec: {@code docs/specs/topic-routing.md}.
 */
class TopicRoutingIntegrationTest extends AbstractRedisIntegrationTest {

    private static final String EXCHANGE = TopicRoutingService.EXCHANGE_STREAM;

    private TopicRoutingService service;

    @BeforeEach
    void seedRulesAndService() throws Exception {
        try (var jedis = jedisPool.getResource()) {
            jedis.functionLoadReplace(Files.readString(Path.of("lua/stream_utils.lua")));
        }
        var objectMapper = new ObjectMapper();
        var listener = new RedisStreamListenerService(jedisPool, new WebSocketEventService(objectMapper));
        service = new TopicRoutingService(jedisPool, listener, objectMapper);

        // The five default rules are the demo's subject matter; seed them the way startup does.
        // The @Lazy collaborators are only used by resetToDefaults()'s stream cleanup, not by seeding.
        new RoutingRulesService(jedisPool, objectMapper, null, null, null, null, null)
            .initializeDefaultRulesAndMetadata();
    }

    @Test
    void aKeyMatchingSeveralRulesIsDeliveredToEveryMatchingStream() {
        var result = service.routeMessage("order.created.vip.eu.v1", "EVT-1", Map.of());

        assertThat(destinationsOf(result))
            .as("v1 routing + VIP notification + GDPR notification all apply")
            .containsExactlyInAnyOrder(
                TopicRoutingService.ORDER_V1_STREAM,
                TopicRoutingService.VIP_NOTIFICATION_STREAM,
                TopicRoutingService.GDPR_NOTIFICATION_STREAM);
        assertThat(streamLength(TopicRoutingService.ORDER_V1_STREAM)).isEqualTo(1);
        assertThat(streamLength(TopicRoutingService.VIP_NOTIFICATION_STREAM)).isEqualTo(1);
        assertThat(streamLength(TopicRoutingService.GDPR_NOTIFICATION_STREAM)).isEqualTo(1);
        assertThat(streamLength(TopicRoutingService.ORDER_V2_STREAM)).isZero();
    }

    @Test
    void stopOnMatchTruncatesEvaluationSoLowerPriorityRulesNeverRun() {
        // Same key as above plus "cancelled": rule 001 (priority 1, stopOnMatch) wins alone.
        var result = service.routeMessage("order.cancelled.vip.eu.v1", "EVT-2", Map.of());

        assertThat(destinationsOf(result))
            .as("audit only — VIP and GDPR must not fire for a cancelled order")
            .containsExactly(TopicRoutingService.CANCELLED_AUDIT_STREAM);
        assertThat(streamLength(TopicRoutingService.VIP_NOTIFICATION_STREAM)).isZero();
        assertThat(streamLength(TopicRoutingService.GDPR_NOTIFICATION_STREAM)).isZero();
    }

    @Test
    void versionRoutingSendsV2ToTheV2StreamOnly() {
        var result = service.routeMessage("order.created.regular.us.v2", "EVT-3", Map.of());

        assertThat(destinationsOf(result)).containsExactly(TopicRoutingService.ORDER_V2_STREAM);
        assertThat(streamLength(TopicRoutingService.ORDER_V1_STREAM)).isZero();
    }

    @Test
    void anUnmatchedKeyStillEntersTheExchangeButReachesNoDestination() {
        var result = service.routeMessage("telemetry.heartbeat", "EVT-4", Map.of());

        assertThat(destinationsOf(result)).isEmpty();
        assertThat(result.getExchangeId()).as("the exchange keeps the audit trail").isNotBlank();
        assertThat(streamLength(EXCHANGE)).isEqualTo(1);
    }

    @Test
    void theRoutedPayloadCarriesTheCallersFieldsAndTheRoutingKey() {
        service.routeMessage("order.created.regular.eu.v1", "EVT-5", Map.of("customerId", "C-9"));

        Map<String, String> routed = onlyEntryOf(TopicRoutingService.ORDER_V1_STREAM);
        // route_message flattens the caller's JSON into stream fields rather than nesting it under a
        // `payload` field, and adds its own: routingKey, routedAt, and the apiVersion it derived
        // from the key's suffix. Consumers read plain fields, no JSON parsing on the hot path.
        assertThat(routed)
            .containsEntry("eventId", "EVT-5")
            .containsEntry("customerId", "C-9")
            .containsEntry("routingKey", "order.created.regular.eu.v1")
            .containsEntry("apiVersion", "v1")
            .containsKeys("createdAt", "routedAt");
    }

    /** The result carries {@code RoutedStream} records; only the stream names matter here. */
    private static List<String> destinationsOf(TopicRoutingService.RoutingResult result) {
        return result.getRoutedTo().stream().map(TopicRoutingService.RoutedStream::getStreamName).toList();
    }

    private long streamLength(String stream) {
        try (var jedis = jedisPool.getResource()) {
            return jedis.exists(stream) ? jedis.xlen(stream) : 0L;
        }
    }

    private Map<String, String> onlyEntryOf(String stream) {
        try (var jedis = jedisPool.getResource()) {
            var entries = jedis.xrange(stream, (StreamEntryID) null, (StreamEntryID) null, 10);
            assertThat(entries).hasSize(1);
            return entries.get(0).getFields();
        }
    }

    /** Guards the assumption every other test here rests on: the rules really are in Redis. */
    @Test
    void theDefaultRuleSetIsSeeded() {
        try (var jedis = jedisPool.getResource()) {
            Map<String, String> rules = jedis.hgetAll("routing:rules:" + EXCHANGE);
            assertThat(rules.keySet()).containsExactlyInAnyOrderElementsOf(
                List.of("001", "010", "011", "020", "021"));
        }
    }
}
