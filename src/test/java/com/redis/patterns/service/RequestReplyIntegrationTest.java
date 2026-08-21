package com.redis.patterns.service;

import com.redis.patterns.support.AbstractRedisIntegrationTest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.JedisPoolConfig;
import redis.clients.jedis.StreamEntryID;
import tools.jackson.databind.ObjectMapper;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.function.BooleanSupplier;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Integration tests for Request/Reply over streams: a request carries a correlation id, the responder
 * answers on a second stream, and an unanswered request is caught by a key expiry rather than by the
 * caller polling.
 *
 * <p>The timeout mechanism (ADR-0007) is the part worth pinning: {@code sendRequest} writes a
 * short-lived key plus a persistent "shadow" copy, because the expiry notification carries only the
 * key name — the payload has to survive it.
 *
 * <p>Spec: {@code docs/specs/request-reply.md}.
 */
class RequestReplyIntegrationTest extends AbstractRedisIntegrationTest {

    private static final String REQUEST_STREAM = "order.holdInventory.v1";
    private static final String RESPONSE_STREAM = "order.holdInventory.response.v1";
    private static final String TIMEOUT_KEY_PREFIX = "order.holdInventory.request.timeout.v1:";
    private static final String SHADOW_KEY_PREFIX = "order.holdInventory.request.timeout.shadow.v1:";

    private JedisPool servicePool;
    private RequestReplyService service;

    @BeforeEach
    void startService() throws Exception {
        JedisPoolConfig config = new JedisPoolConfig();
        config.setMaxTotal(32);
        config.setMaxIdle(32);
        servicePool = new JedisPool(config, REDIS_HOST, redisPort);
        try (var jedis = servicePool.getResource()) {
            jedis.functionLoadReplace(Files.readString(Path.of("lua/stream_utils.lua")));
        }
        service = new RequestReplyService(servicePool, new ObjectMapper(),
                                          new WebSocketEventService(new ObjectMapper()));
        // @PostConstruct in the app; called explicitly here — it creates the groups and starts both
        // listener threads.
        service.initializeConsumerGroups();
    }

    @AfterEach
    void stopService() {
        if (service != null) {
            service.stopListeners();
        }
        if (servicePool != null) {
            servicePool.close();
        }
    }

    @Test
    void anOkRequestGetsAnAnswerCarryingTheSameCorrelationId() throws Exception {
        String correlationId = service.sendRequest(Map.of(
            "orderId", "ORD-1",
            "responseType", "OK",
            "items", List.of(Map.of("itemId", "SKU-1", "quantity", 2))));

        awaitTrue(() -> responseFor(correlationId) != null, Duration.ofSeconds(15),
                  "the responder to answer");

        Map<String, String> response = responseFor(correlationId);
        assertThat(response)
            .as("the correlation id is what lets the caller match an answer to its own request")
            .containsEntry("correlationId", correlationId)
            .containsEntry("responseType", "OK")
            .containsEntry("businessId", "ORD-1");
        awaitTrue(() -> requestPending() == 0, Duration.ofSeconds(10), "the request to be ACKed");

        try (var jedis = servicePool.getResource()) {
            assertThat(jedis.exists(TIMEOUT_KEY_PREFIX + correlationId))
                .as("answering deletes the timeout key, which is how a reply cancels its own timeout")
                .isFalse();
        }
    }

    @Test
    void aKoRequestIsAnsweredAndStillAcked() throws Exception {
        String correlationId = service.sendRequest(Map.of(
            "orderId", "ORD-2",
            "responseType", "KO",
            "items", List.of(Map.of("itemId", "SKU-2", "quantity", 99))));

        awaitTrue(() -> responseFor(correlationId) != null, Duration.ofSeconds(15), "the KO answer");

        assertThat(responseFor(correlationId)).containsEntry("responseType", "KO");
        awaitTrue(() -> requestPending() == 0, Duration.ofSeconds(10),
                  "a business KO is still a processed message, so it must be ACKed");
    }

    @Test
    void anErrorRequestIsNotAckedSoItCanBeRetried() throws Exception {
        service.sendRequest(Map.of(
            "orderId", "ORD-3",
            "responseType", "ERROR",
            "items", List.of(Map.of("itemId", "SKU-3", "quantity", 1))));

        // ERROR means "the responder failed", so the message must stay in the PEL.
        Thread.sleep(3_000);
        assertThat(requestPending())
            .as("an infrastructure failure must remain pending for redelivery, unlike a business KO")
            .isPositive();
    }

    @Test
    void sendRequestArmsATimeoutKeyAndAShadowCopyThatOutlivesIt() throws Exception {
        String correlationId = service.sendRequest(Map.of(
            "orderId", "ORD-4",
            "responseType", "TIMEOUT",
            "items", List.of(Map.of("itemId", "SKU-4", "quantity", 1))));

        try (var jedis = servicePool.getResource()) {
            long ttl = jedis.ttl(TIMEOUT_KEY_PREFIX + correlationId);
            assertThat(ttl)
                .as("the timeout key is the trigger: its expiry is what notifies the app (ADR-0007)")
                .isBetween(1L, 11L);
            assertThat(jedis.exists(SHADOW_KEY_PREFIX + correlationId))
                .as("a keyspace expiry event carries only the key name, so the payload has to be "
                    + "kept in a shadow key that does not expire with it")
                .isTrue();
            assertThat(jedis.ttl(SHADOW_KEY_PREFIX + correlationId))
                .as("the shadow copy must outlive the trigger")
                .satisfiesAnyOf(
                    t -> assertThat(t).isEqualTo(-1L),          // no expiry at all
                    t -> assertThat(t).isGreaterThan(ttl));     // or a longer one
        }
    }

    @Test
    void aTimeoutRequestIsNeverAnsweredAndStaysPending() throws Exception {
        String correlationId = service.sendRequest(Map.of(
            "orderId", "ORD-5",
            "responseType", "TIMEOUT",
            "items", List.of(Map.of("itemId", "SKU-5", "quantity", 1))));

        Thread.sleep(4_000);

        assertThat(responseFor(correlationId))
            .as("the TIMEOUT scenario simulates a responder that never answers")
            .isNull();
        assertThat(requestPending()).isPositive();
    }

    private Map<String, String> responseFor(String correlationId) {
        try (var jedis = servicePool.getResource()) {
            if (!jedis.exists(RESPONSE_STREAM)) {
                return null;
            }
            // The Lua `response` function flattens the payload into stream fields (nested values
            // JSON-encoded), so correlationId is a field of its own — there is no `payload` blob.
            return jedis.xrange(RESPONSE_STREAM, (StreamEntryID) null, (StreamEntryID) null, 100).stream()
                .map(StreamEntryFields::of)
                .filter(f -> correlationId.equals(f.get("correlationId")))
                .findFirst()
                .orElse(null);
        }
    }

    private long requestPending() {
        try (var jedis = servicePool.getResource()) {
            var info = jedis.xpending(REQUEST_STREAM, "inventory-service");
            return info == null ? 0 : info.getTotal();
        }
    }

    /** Tiny helper so the stream-entry lambda above stays readable. */
    private interface StreamEntryFields {
        static Map<String, String> of(redis.clients.jedis.resps.StreamEntry entry) {
            return entry.getFields();
        }
    }

    private void awaitTrue(BooleanSupplier condition, Duration timeout, String what) throws Exception {
        Instant deadline = Instant.now().plus(timeout);
        while (Instant.now().isBefore(deadline)) {
            if (condition.getAsBoolean()) {
                return;
            }
            Thread.sleep(150);
        }
        throw new AssertionError("Timed out waiting for " + what);
    }
}
