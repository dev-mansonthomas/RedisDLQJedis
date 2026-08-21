package com.redis.patterns.service;

import tools.jackson.databind.ObjectMapper;
import com.redis.patterns.config.LlmChatProperties;
import com.redis.patterns.service.llm.MockLlmClient;
import com.redis.patterns.support.AbstractRedisIntegrationTest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import redis.clients.jedis.StreamEntryID;
import redis.clients.jedis.params.XAddParams;
import redis.clients.jedis.params.XReadGroupParams;

import java.time.Duration;
import java.time.Instant;
import java.util.Collections;
import java.util.Map;
import java.util.function.BooleanSupplier;

import static org.assertj.core.api.Assertions.assertThat;

/** Integration tests for crash recovery (XAUTOCLAIM) and DLQ routing. */
class LlmRecoverySweeperTest extends AbstractRedisIntegrationTest {

    private LlmChatProperties props;
    private LlmResponderWorker responder;
    private LlmRecoverySweeper sweeper;

    @BeforeEach
    void setUp() {
        props = new LlmChatProperties();
        props.getResilience().setMinIdleMs(100);
        props.getResilience().setSweepIntervalMs(100);
        props.getResilience().setMaxDeliveries(2);
        responder = new LlmResponderWorker(jedisPool,
                new WebSocketEventService(new ObjectMapper()), new MockLlmClient(0), props);
        sweeper = new LlmRecoverySweeper(jedisPool, responder, props);
    }

    @AfterEach
    void tearDown() {
        sweeper.stopAll();
        responder.stopAll();
    }

    /** Seed a user message that was delivered to responder-1 but never ACKed (a "dead" worker). */
    private void seedPending(String chatKey, String content, String msgId) {
        try (var jedis = jedisPool.getResource()) {
            jedis.xgroupCreate(chatKey, LlmChatService.RESPONDER_GROUP,
                    StreamEntryID.XGROUP_LAST_ENTRY, true);
            jedis.xadd(chatKey, XAddParams.xAddParams(),
                    Map.of("role", "user", "content", content, "ts", "1", "msgId", msgId));
            jedis.xreadGroup(LlmChatService.RESPONDER_GROUP, "responder-1",
                    XReadGroupParams.xReadGroupParams().count(1),
                    Collections.singletonMap(chatKey, StreamEntryID.XREADGROUP_UNDELIVERED_ENTRY));
        }
    }

    private long pending(String chatKey) {
        try (var jedis = jedisPool.getResource()) {
            return jedis.xpending(chatKey, LlmChatService.RESPONDER_GROUP).getTotal();
        }
    }

    private boolean hasAssistant(String chatKey) {
        try (var jedis = jedisPool.getResource()) {
            return jedis.xrange(chatKey, StreamEntryID.MINIMUM_ID, StreamEntryID.MAXIMUM_ID).stream()
                    .anyMatch(e -> "assistant".equals(e.getFields().get("role")));
        }
    }

    private long dlqLen(String cid) {
        try (var jedis = jedisPool.getResource()) {
            return jedis.exists(LlmChatService.dlqKey(cid)) ? jedis.xlen(LlmChatService.dlqKey(cid)) : 0;
        }
    }

    private void awaitUntil(BooleanSupplier cond) {
        Instant deadline = Instant.now().plus(Duration.ofSeconds(15));
        while (Instant.now().isBefore(deadline)) {
            if (cond.getAsBoolean()) {
                return;
            }
            try {
                Thread.sleep(50);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
    }

    @Test
    void stalePendingIsReclaimedAndRegenerated() {
        String cid = "conv1";
        String chatKey = LlmChatService.chatKey(cid);
        seedPending(chatKey, "hello there", "u1");
        assertThat(pending(chatKey)).isEqualTo(1);

        sweeper.startFor(cid);

        awaitUntil(() -> hasAssistant(chatKey) && pending(chatKey) == 0);

        assertThat(hasAssistant(chatKey)).isTrue();
        assertThat(pending(chatKey)).isZero();
        assertThat(dlqLen(cid)).isZero();
    }

    @Test
    void poisonMessageIsRoutedToDlqAfterMaxDeliveries() {
        String cid = "conv2";
        String chatKey = LlmChatService.chatKey(cid);
        seedPending(chatKey, "/fail do the thing", "u1");

        sweeper.startFor(cid);

        // Routing to the DLQ and ACKing out of the main stream are two calls, not one, so waiting on
        // the DLQ alone occasionally observed the ACK that had not landed yet. Await both.
        awaitUntil(() -> dlqLen(cid) == 1 && pending(chatKey) == 0);

        assertThat(dlqLen(cid)).isEqualTo(1);
        assertThat(pending(chatKey)).isZero();  // acked out of the main stream
        assertThat(hasAssistant(chatKey)).isFalse(); // never generated a reply
        try (var jedis = jedisPool.getResource()) {
            var dlq = jedis.xrange(LlmChatService.dlqKey(cid),
                    StreamEntryID.MINIMUM_ID, StreamEntryID.MAXIMUM_ID).get(0);
            assertThat(dlq.getFields()).containsEntry("msgId", "u1");
            assertThat(dlq.getFields().get("reason")).contains("max deliveries");
        }
    }
}
