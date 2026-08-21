package com.redis.patterns.service;

import com.redis.patterns.support.AbstractRedisIntegrationTest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.JedisPoolConfig;
import tools.jackson.databind.ObjectMapper;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.function.BooleanSupplier;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Integration tests for Content-Based Routing: the destination comes from the message's own content
 * (a payment amount) rather than from a routing key.
 *
 * <p>The thresholds are asserted directly, and one payment is followed end to end through the router
 * loop so the test also covers the {@code read_claim_or_dlq} read path and the ACK.
 *
 * <p>Spec: {@code docs/specs/content-based-routing.md}.
 */
class ContentBasedRoutingIntegrationTest extends AbstractRedisIntegrationTest {

    private JedisPool servicePool;
    private ContentBasedRoutingService service;
    private RedisStreamListenerService listener;

    @BeforeEach
    void startService() throws Exception {
        JedisPoolConfig config = new JedisPoolConfig();
        config.setMaxTotal(32);
        config.setMaxIdle(32);
        servicePool = new JedisPool(config, REDIS_HOST, redisPort);
        try (var jedis = servicePool.getResource()) {
            jedis.functionLoadReplace(Files.readString(Path.of("lua/stream_utils.lua")));
        }
        var ws = new WebSocketEventService(new ObjectMapper());
        listener = new RedisStreamListenerService(servicePool, ws);
        service = new ContentBasedRoutingService(servicePool, ws, listener);
    }

    @AfterEach
    void stopService() {
        if (service != null) {
            service.stopRouter();
        }
        if (listener != null) {
            listener.shutdown();
        }
        if (servicePool != null) {
            servicePool.close();
        }
    }

    @ParameterizedTest(name = "{0} → {1}")
    @CsvSource({
        "50,      payments.standard.v1",
        "99.99,   payments.standard.v1",
        "100,     payments.highRisk.v1",     // threshold is inclusive
        "9999.99, payments.highRisk.v1",
        "10000,   payments.manualReview.v1", // threshold is inclusive
        "150000,  payments.manualReview.v1"
    })
    void theAmountAloneDecidesTheDestination(double amount, String expectedStream) {
        assertThat(service.determineTargetStream(amount)).isEqualTo(expectedStream);
    }

    @Test
    void theThresholdFunctionDoesNotGuardAgainstNegativeAmounts() {
        // By design: `amount < 0` is rejected by the router loop *before* it asks for a tier, so the
        // threshold function alone maps -15 to standard. Pinned because it reads like a bug otherwise
        // — anyone reusing determineTargetStream() outside the loop needs to add the guard themselves.
        assertThat(service.determineTargetStream(-15))
            .isEqualTo(ContentBasedRoutingService.STANDARD_STREAM);
    }

    @Test
    void aNegativeAmountIsRetriedThenLandsInTheDlq() throws Exception {
        service.run();

        service.submitPayment("PAY-POISON", -15.0, "FR", "card");

        // MAX_DELIVERIES is 2 and each attempt sleeps 2s before failing, so allow a wide window.
        awaitTrue(() -> streamLength(ContentBasedRoutingService.DLQ_STREAM) == 1,
                  Duration.ofSeconds(30), "the poison payment to reach the DLQ");

        assertThat(streamLength(ContentBasedRoutingService.STANDARD_STREAM))
            .as("a negative amount must never be accepted as a low-value payment")
            .isZero();
        assertThat(streamLength(ContentBasedRoutingService.HIGH_RISK_STREAM)).isZero();
        assertThat(streamLength(ContentBasedRoutingService.MANUAL_REVIEW_STREAM)).isZero();
    }

    @Test
    void aMessageWithNoAmountIsTreatedAsMalformedNotAsAZeroPayment() throws Exception {
        service.run();

        try (var jedis = servicePool.getResource()) {
            jedis.xadd(ContentBasedRoutingService.INCOMING_STREAM,
                       redis.clients.jedis.params.XAddParams.xAddParams(),
                       java.util.Map.of("paymentId", "PAY-NOAMOUNT", "country", "FR"));
        }

        awaitTrue(() -> streamLength(ContentBasedRoutingService.DLQ_STREAM) == 1,
                  Duration.ofSeconds(30), "the malformed payment to reach the DLQ");
        assertThat(streamLength(ContentBasedRoutingService.STANDARD_STREAM)).isZero();
    }

    @Test
    void aSubmittedPaymentTravelsFromTheIncomingStreamToItsTierAndIsAcked() throws Exception {
        service.run();

        service.submitPayment("PAY-1", 250.0, "FR", "card");

        // The router sleeps ROUTER_STARTUP_DELAY_MS (2s) before each message, hence the wide window.
        awaitTrue(() -> streamLength(ContentBasedRoutingService.HIGH_RISK_STREAM) == 1,
                  Duration.ofSeconds(15), "the payment to reach the high-risk tier");

        assertThat(streamLength(ContentBasedRoutingService.STANDARD_STREAM)).isZero();
        assertThat(streamLength(ContentBasedRoutingService.MANUAL_REVIEW_STREAM)).isZero();

        awaitTrue(() -> pendingCount() == 0, Duration.ofSeconds(10), "the message to be ACKed");
        assertThat(streamLength(ContentBasedRoutingService.DLQ_STREAM))
            .as("a routable payment must not reach the DLQ")
            .isZero();
    }

    @Test
    void theRouterIsASingleConsumerSoNoPeerCanClaimAnInFlightMessage() throws Exception {
        service.run();
        service.submitPayment("PAY-2", 50.0, "FR", "card");
        awaitTrue(() -> streamLength(ContentBasedRoutingService.STANDARD_STREAM) == 1,
                  Duration.ofSeconds(15), "the payment to be routed");

        try (var jedis = servicePool.getResource()) {
            var consumers = jedis.xinfoConsumers(
                ContentBasedRoutingService.INCOMING_STREAM, ContentBasedRoutingService.CONSUMER_GROUP);
            assertThat(consumers)
                .as("MIN_IDLE_MS is 100ms against a 2s processing delay, which would be unsafe with "
                    + "competing consumers — it is only safe because the group has exactly one")
                .hasSize(1);
        }
        assertThat(streamLength(ContentBasedRoutingService.STANDARD_STREAM))
            .as("routed exactly once, not twice")
            .isEqualTo(1);
    }

    private long streamLength(String stream) {
        try (var jedis = servicePool.getResource()) {
            return jedis.exists(stream) ? jedis.xlen(stream) : 0L;
        }
    }

    private long pendingCount() {
        try (var jedis = servicePool.getResource()) {
            var info = jedis.xpending(ContentBasedRoutingService.INCOMING_STREAM,
                                     ContentBasedRoutingService.CONSUMER_GROUP);
            return info == null ? 0 : info.getTotal();
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
