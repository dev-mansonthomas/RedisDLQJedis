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
import redis.clients.jedis.resps.StreamEntry;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

/** Integration tests for the responder worker end-to-end against a real Redis. */
class LlmResponderWorkerTest extends AbstractRedisIntegrationTest {

    private LlmResponderWorker worker;

    @BeforeEach
    void setUpWorker() {
        LlmChatProperties props = new LlmChatProperties();
        worker = new LlmResponderWorker(jedisPool, new WebSocketEventService(new ObjectMapper()),
                new MockLlmClient(0), props);
    }

    @AfterEach
    void stopWorker() {
        worker.stopAll();
    }

    private void createGroup(String chatKey) {
        try (var jedis = jedisPool.getResource()) {
            jedis.xgroupCreate(chatKey, LlmChatService.RESPONDER_GROUP,
                    StreamEntryID.XGROUP_LAST_ENTRY, true);
        }
    }

    private void addUserMessage(String chatKey, String content) {
        try (var jedis = jedisPool.getResource()) {
            jedis.xadd(chatKey, XAddParams.xAddParams(),
                    Map.of("role", "user", "content", content, "ts", "1", "msgId", "u1"));
        }
    }

    private Optional<StreamEntry> findAssistant(String chatKey) {
        try (var jedis = jedisPool.getResource()) {
            if (!jedis.exists(chatKey)) {
                return Optional.empty();
            }
            return jedis.xrange(chatKey, StreamEntryID.MINIMUM_ID, StreamEntryID.MAXIMUM_ID).stream()
                    .filter(e -> "assistant".equals(e.getFields().get("role")))
                    .findFirst();
        }
    }

    private void awaitUntil(Duration timeout, java.util.function.BooleanSupplier condition) {
        Instant deadline = Instant.now().plus(timeout);
        while (Instant.now().isBefore(deadline)) {
            if (condition.getAsBoolean()) {
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
    void userMessageProducesStreamedAssistantReplyAndAcks() {
        String chatKey = "chat:conv1";
        createGroup(chatKey);
        worker.startFor("conv1");
        addUserMessage(chatKey, "hello there");

        awaitUntil(Duration.ofSeconds(10), () -> findAssistant(chatKey).isPresent());

        StreamEntry assistant = findAssistant(chatKey).orElseThrow();
        String respId = assistant.getFields().get("msgId");
        String content = assistant.getFields().get("content");
        assertThat(content).isNotBlank();
        assertThat(assistant.getFields()).containsEntry("model", "mock");

        // Assistant content equals the concatenation of the tokens streamed for that response.
        try (var jedis = jedisPool.getResource()) {
            List<StreamEntry> tokens =
                    jedis.xrange("chat:conv1:tok", StreamEntryID.MINIMUM_ID, StreamEntryID.MAXIMUM_ID);
            String concatenated = tokens.stream()
                    .filter(t -> respId.equals(t.getFields().get("msgId")))
                    .map(t -> t.getFields().get("token"))
                    .reduce("", String::concat);
            assertThat(concatenated).isEqualTo(content);

            // The user message is acknowledged: nothing left pending.
            assertThat(jedis.xpending(chatKey, LlmChatService.RESPONDER_GROUP).getTotal()).isZero();
        }
    }

    @Test
    void replyContextIsBoundedToTheTriggeringMessage() {
        // Two user turns are queued before the worker starts; each reply must be built from context
        // up to its own message, so reply #1 echoes ALPHA (not the later BRAVO).
        String chatKey = "chat:conv3";
        createGroup(chatKey);
        try (var jedis = jedisPool.getResource()) {
            jedis.xadd(chatKey, XAddParams.xAddParams(),
                    Map.of("role", "user", "content", "ALPHA", "ts", "1", "msgId", "u1"));
            jedis.xadd(chatKey, XAddParams.xAddParams(),
                    Map.of("role", "user", "content", "BRAVO", "ts", "2", "msgId", "u2"));
        }
        worker.startFor("conv3");

        awaitUntil(Duration.ofSeconds(10), () -> {
            try (var jedis = jedisPool.getResource()) {
                return jedis.xrange(chatKey, StreamEntryID.MINIMUM_ID, StreamEntryID.MAXIMUM_ID).stream()
                        .filter(e -> "assistant".equals(e.getFields().get("role"))).count() == 2;
            }
        });

        try (var jedis = jedisPool.getResource()) {
            List<String> assistantContents = jedis
                    .xrange(chatKey, StreamEntryID.MINIMUM_ID, StreamEntryID.MAXIMUM_ID).stream()
                    .filter(e -> "assistant".equals(e.getFields().get("role")))
                    .map(e -> e.getFields().get("content"))
                    .toList();
            // Each user turn got its own reply; ALPHA's reply is not hijacked by the later BRAVO.
            assertThat(assistantContents).anyMatch(c -> c.contains("ALPHA"));
            assertThat(assistantContents).anyMatch(c -> c.contains("BRAVO"));
        }
    }

    @Test
    void armedKillLeavesMessagePendingWithoutReply() {
        String chatKey = "chat:conv4";
        createGroup(chatKey);
        worker.armKill("conv4");
        worker.startFor("conv4");
        addUserMessage(chatKey, "hello there");

        // The message is delivered (pending) but generation aborts before XACK → no assistant turn.
        awaitUntil(Duration.ofSeconds(10), () -> {
            try (var jedis = jedisPool.getResource()) {
                return jedis.xpending(chatKey, LlmChatService.RESPONDER_GROUP).getTotal() == 1;
            }
        });
        sleep(500); // grace: ensure no reply is produced

        try (var jedis = jedisPool.getResource()) {
            assertThat(jedis.xlen(chatKey)).isEqualTo(1); // only the user turn
            assertThat(jedis.exists("chat:conv4:tok")).isFalse();
            assertThat(jedis.xpending(chatKey, LlmChatService.RESPONDER_GROUP).getTotal()).isEqualTo(1);
        }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    @Test
    void completedReplyClearsTheTimeoutKey() {
        String chatKey = "chat:conv5";
        createGroup(chatKey);
        try (var jedis = jedisPool.getResource()) {
            jedis.setex("llm:timeout:u1", 60, "1"); // addUserMessage uses msgId "u1"
        }
        worker.startFor("conv5");
        addUserMessage(chatKey, "hello there");

        awaitUntil(Duration.ofSeconds(10), () -> findAssistant(chatKey).isPresent());

        try (var jedis = jedisPool.getResource()) {
            assertThat(jedis.exists("llm:timeout:u1")).isFalse(); // reply in time → timeout cancelled
        }
    }

    @Test
    void nonUserEntryIsAckedWithoutGenerating() {
        String chatKey = "chat:conv2";
        createGroup(chatKey);
        worker.startFor("conv2");

        // Directly append an assistant turn (as the group would re-deliver our own output).
        try (var jedis = jedisPool.getResource()) {
            jedis.xadd(chatKey, XAddParams.xAddParams(),
                    Map.of("role", "assistant", "content", "prior", "ts", "1", "msgId", "a1", "model", "mock"));
        }

        // Wait for it to be consumed & ACKed.
        awaitUntil(Duration.ofSeconds(10), () -> {
            try (var jedis = jedisPool.getResource()) {
                return jedis.xpending(chatKey, LlmChatService.RESPONDER_GROUP).getTotal() == 0;
            }
        });

        try (var jedis = jedisPool.getResource()) {
            // No generation happened: still exactly one entry, no token stream.
            assertThat(jedis.xlen(chatKey)).isEqualTo(1);
            assertThat(jedis.exists("chat:conv2:tok")).isFalse();
            assertThat(jedis.xpending(chatKey, LlmChatService.RESPONDER_GROUP).getTotal()).isZero();
        }
    }
}
