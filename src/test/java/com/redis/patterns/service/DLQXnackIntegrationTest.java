package com.redis.patterns.service;

import tools.jackson.databind.ObjectMapper;
import com.redis.patterns.config.DLQProperties;
import com.redis.patterns.dto.DLQConfigRequest;
import com.redis.patterns.dto.DLQMessage;
import com.redis.patterns.dto.DLQParameters;
import com.redis.patterns.dto.ProcessOutcome;
import com.redis.patterns.support.AbstractRedisIntegrationTest;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import redis.clients.jedis.args.XNackMode;
import redis.clients.jedis.StreamEntryID;
import redis.clients.jedis.params.XAddParams;
import redis.clients.jedis.params.XReadGroupParams;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Integration tests for the XNACK explicit-failure semantics (Redis 8.8+) on the DLQ pattern.
 *
 * <p>Covers the released-PEL-entry shape (no owner, idle -1) through
 * {@link DLQMessagingService#getPendingMessages}, and the three XNACK modes' effect on the
 * delivery counter (SILENT → 0, FAIL → kept, FATAL → Long.MAX poison).
 */
class DLQXnackIntegrationTest extends AbstractRedisIntegrationTest {

    private static final String STREAM = "test-stream";
    private static final String DLQ_STREAM = "test-stream:dlq";
    private static final String GROUP = "test-group";
    private static final String CONSUMER = "consumer-1";

    private DLQMessagingService service;
    private DLQConfigService configService;

    @BeforeEach
    void setUp() throws Exception {
        configService = new DLQConfigService();
        service = new DLQMessagingService(jedisPool, new DLQProperties(),
                new WebSocketEventService(new ObjectMapper()), configService);
        try (var jedis = jedisPool.getResource()) {
            jedis.functionLoadReplace(Files.readString(Path.of("lua/stream_utils.lua")));
        }
        service.initializeConsumerGroup(STREAM, GROUP);
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    /** XADD one message and deliver it once to {@link #CONSUMER}; returns the entry id. */
    private String produceAndDeliverOnce() {
        try (var jedis = jedisPool.getResource()) {
            StreamEntryID id = jedis.xadd(STREAM, XAddParams.xAddParams(),
                    Map.of("type", "order.created", "order_id", "42"));
            jedis.xreadGroup(GROUP, CONSUMER,
                    XReadGroupParams.xReadGroupParams().count(10),
                    Collections.singletonMap(STREAM, StreamEntryID.XREADGROUP_UNDELIVERED_ENTRY));
            return id.toString();
        }
    }

    private long xnack(String mode, String id) {
        try (var jedis = jedisPool.getResource()) {
            return jedis.xnack(STREAM, GROUP, XNackMode.valueOf(mode), new StreamEntryID(id));
        }
    }

    private Map<String, Object> onlyPending() {
        List<Map<String, Object>> pending = service.getPendingMessages(STREAM, GROUP, 10);
        assertThat(pending).hasSize(1);
        return pending.get(0);
    }

    // ------------------------------------------------------------------
    // getPendingMessages: released/poisoned PEL entry shape (task 2/3)
    // ------------------------------------------------------------------

    @Test
    void getPendingMessages_returnsConsumerAndIdle_forOwnedEntry() {
        String id = produceAndDeliverOnce();

        Map<String, Object> entry = onlyPending();

        assertThat(entry.get("id")).isEqualTo(id);
        assertThat(entry.get("consumer")).isEqualTo(CONSUMER);
        assertThat((Long) entry.get("idleMs")).isGreaterThanOrEqualTo(0L);
        assertThat(entry.get("deliveryCount")).isEqualTo(1L);
    }

    @Test
    void getPendingMessages_parsesReleasedEntry_noThrow() {
        String id = produceAndDeliverOnce();
        assertThat(xnack("FAIL", id)).isEqualTo(1L);

        Map<String, Object> entry = onlyPending();

        assertThat(entry.get("consumer")).isEqualTo("");
        assertThat((Long) entry.get("idleMs")).isEqualTo(-1L);
        assertThat(entry.get("deliveryCount")).isEqualTo(1L); // FAIL keeps the failure budget spent
    }

    @Test
    void getPendingMessages_poisonEntry_counterIsLongMax() {
        String id = produceAndDeliverOnce();
        assertThat(xnack("FATAL", id)).isEqualTo(1L);

        Map<String, Object> entry = onlyPending();

        assertThat(entry.get("deliveryCount")).isEqualTo(Long.MAX_VALUE);
        assertThat(entry.get("consumer")).isEqualTo("");
        assertThat((Long) entry.get("idleMs")).isEqualTo(-1L);
    }

    // ------------------------------------------------------------------
    // processNextMessage(ProcessOutcome): explicit-failure semantics (task 4)
    // ------------------------------------------------------------------

    /** minIdle of 60s: anything re-delivered "immediately" proves XNACK bypasses the idle wait. */
    private static final long LONG_IDLE_MS = 60_000L;

    private void useLongIdleConfig() {
        configService.saveConfiguration(DLQConfigRequest.builder()
                .streamName(STREAM).dlqStreamName(DLQ_STREAM)
                .consumerGroup(GROUP).consumerName(CONSUMER)
                .minIdleMs(LONG_IDLE_MS).count(100).maxDeliveries(2)
                .build());
    }

    private DLQParameters longIdleParams() {
        return DLQParameters.builder()
                .streamName(STREAM).dlqStreamName(DLQ_STREAM)
                .consumerGroup(GROUP).consumerName(CONSUMER)
                .minIdleMs(LONG_IDLE_MS).count(100).maxDeliveries(2)
                .build();
    }

    @Test
    void nackFail_keepsCounter_immediatelyRetryable() {
        useLongIdleConfig();
        String id = service.produceMessage(STREAM, Map.of("type", "order.created", "order_id", "1"));

        Map<String, Object> resp = service.processNextMessage(ProcessOutcome.NACK_FAIL);

        assertThat(resp.get("success")).isEqualTo(true);
        assertThat(resp.get("outcome")).isEqualTo("NACK_FAIL");
        Map<String, Object> entry = onlyPending();
        assertThat(entry.get("consumer")).isEqualTo("");
        assertThat(entry.get("deliveryCount")).isEqualTo(1L);

        // Despite minIdle = 60s, the released message is claimable right away.
        List<DLQMessage> redelivered = service.getNextMessages(longIdleParams(), 10);
        assertThat(redelivered).extracting(DLQMessage::getId).containsExactly(id);
    }

    @Test
    void nackFatal_sweptToDlq_onNextPollWithoutWait() {
        useLongIdleConfig();
        service.produceMessage(STREAM, Map.of("type", "order.created", "order_id", "2"));

        Map<String, Object> resp = service.processNextMessage(ProcessOutcome.NACK_FATAL);

        assertThat(resp.get("success")).isEqualTo(true);
        assertThat(onlyPending().get("deliveryCount")).isEqualTo(Long.MAX_VALUE);

        // Next poll sweeps to DLQ immediately — no minIdle wait, nothing re-delivered.
        List<DLQMessage> next = service.getNextMessages(longIdleParams(), 10);
        assertThat(next).isEmpty();
        try (var jedis = jedisPool.getResource()) {
            assertThat(jedis.xlen(DLQ_STREAM)).isEqualTo(1L);
            assertThat(jedis.xpending(STREAM, GROUP).getTotal()).isZero();
        }
    }

    @Test
    void nackSilent_refundsCounter() {
        useLongIdleConfig();
        String id = service.produceMessage(STREAM, Map.of("type", "order.created", "order_id", "3"));

        Map<String, Object> resp = service.processNextMessage(ProcessOutcome.NACK_SILENT);

        assertThat(resp.get("success")).isEqualTo(true);
        Map<String, Object> entry = onlyPending();
        assertThat(entry.get("deliveryCount")).isEqualTo(0L); // the delivery "never happened"
        assertThat(entry.get("consumer")).isEqualTo("");

        // Immediately claimable; the re-delivery is the first counted one.
        List<DLQMessage> redelivered = service.getNextMessages(longIdleParams(), 10);
        assertThat(redelivered).extracting(DLQMessage::getId).containsExactly(id);
        assertThat(onlyPending().get("deliveryCount")).isEqualTo(1L);
    }

    @Test
    void xnack_onAckedMessage_releasesNothing() {
        String id = produceAndDeliverOnce();
        try (var jedis = jedisPool.getResource()) {
            jedis.xack(STREAM, GROUP, new StreamEntryID(id));
        }

        assertThat(service.xnack(STREAM, GROUP, XNackMode.FAIL, id)).isZero();
    }

    @Test
    void legacyBoolean_mapsToAckAndNoAck() {
        service.produceMessage(STREAM, Map.of("type", "order.created", "order_id", "4"));
        Map<String, Object> ok = service.processNextMessage(true);
        assertThat(ok.get("success")).isEqualTo(true);
        assertThat(service.getPendingMessages(STREAM, GROUP, 10)).isEmpty(); // ACKed

        service.produceMessage(STREAM, Map.of("type", "order.created", "order_id", "5"));
        Map<String, Object> ko = service.processNextMessage(false);
        assertThat(ko.get("success")).isEqualTo(true);
        Map<String, Object> entry = onlyPending();
        assertThat(entry.get("consumer")).isEqualTo(CONSUMER); // still owned: implicit failure
    }
}
