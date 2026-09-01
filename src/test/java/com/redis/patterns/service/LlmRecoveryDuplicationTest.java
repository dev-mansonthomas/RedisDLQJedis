package com.redis.patterns.service;

import com.redis.patterns.config.LlmChatProperties;
import com.redis.patterns.service.llm.MockLlmClient;
import com.redis.patterns.support.AbstractRedisIntegrationTest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import redis.clients.jedis.resps.StreamEntry;
import redis.clients.jedis.StreamEntryID;
import redis.clients.jedis.params.XAddParams;
import tools.jackson.databind.ObjectMapper;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.function.BooleanSupplier;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Duplicate-processing audit for the LLM Chat recovery sweeper — the last claim-based path in the
 * project without one. This is the failure mode that shipped 120 duplicated jobs out of 266 in the
 * Work Queue: a claimant takes a message its peer is still processing, and the work runs twice with
 * no error, an empty PEL and an empty DLQ.
 *
 * <p>What makes this pattern different, and why the audit is not just a copy of
 * {@code TokenBucketIntegrationTest}: every other pattern is protected by <em>timing</em>
 * ({@code minIdle} outlasting the work) or by a <em>Redis</em> lock ({@code SET NX} in Per-Key
 * Serialized). Here {@code minIdleMs} (3250 ms by default) is deliberately <em>shorter</em> than a
 * slow generation, so the sweeper does reclaim live entries — repeatedly. The only thing standing
 * between that and a doubled reply is {@link LlmResponderWorker#isInFlight}, an in-process
 * {@code Set}. So the audit drives that guard head-on rather than saturating the pool, because
 * saturation is the wrong shape for this risk: with every worker busy in lockstep, no idle claimant
 * is ever there to steal anything (the same lesson Per-Key Serialized recorded).
 *
 * <p>Consequence worth knowing: the guard is in-process, so it holds for this single-JVM demo only.
 * A second backend instance sweeping the same conversation would not see the first one's in-flight
 * set. Out of scope here (one instance by design) but a real limit.
 */
class LlmRecoveryDuplicationTest extends AbstractRedisIntegrationTest {

    /** Shorter than every generation below, so the sweeper always reclaims a live entry. */
    private static final long MIN_IDLE_MS = 300;
    private static final long SWEEP_INTERVAL_MS = 100;

    private LlmResponderWorker responder;
    private LlmRecoverySweeper sweeper;

    @AfterEach
    void tearDown() {
        if (sweeper != null) {
            sweeper.stopAll();
        }
        if (responder != null) {
            responder.stopAll();
        }
    }

    /** Starts a live responder and the sweeper for {@code cid}, with a chosen per-token delay. */
    private void startWorkers(String cid, long tokenDelayMs) {
        LlmChatProperties props = new LlmChatProperties();
        props.getResilience().setMinIdleMs(MIN_IDLE_MS);
        props.getResilience().setSweepIntervalMs(SWEEP_INTERVAL_MS);
        props.getResilience().setMaxDeliveries(2);
        responder = new LlmResponderWorker(jedisPool,
                new WebSocketEventService(new ObjectMapper()), new MockLlmClient(tokenDelayMs), props);
        sweeper = new LlmRecoverySweeper(jedisPool, responder, props);
        responder.startFor(cid);
        sweeper.startFor(cid);
    }

    private void createGroup(String chatKey) {
        try (var jedis = jedisPool.getResource()) {
            jedis.xgroupCreate(chatKey, LlmChatService.RESPONDER_GROUP,
                    StreamEntryID.XGROUP_LAST_ENTRY, true);
        }
    }

    private void postUser(String chatKey, String content, String msgId) {
        try (var jedis = jedisPool.getResource()) {
            jedis.xadd(chatKey, XAddParams.xAddParams(),
                    Map.of("role", "user", "content", content,
                            "ts", String.valueOf(System.currentTimeMillis()), "msgId", msgId));
        }
    }

    private List<String> assistantReplies(String chatKey) {
        try (var jedis = jedisPool.getResource()) {
            return jedis.xrange(chatKey, StreamEntryID.MINIMUM_ID, StreamEntryID.MAXIMUM_ID).stream()
                    .filter(e -> "assistant".equals(e.getFields().get("role")))
                    .map(e -> e.getFields().get("content"))
                    .toList();
        }
    }

    private long pending(String chatKey) {
        try (var jedis = jedisPool.getResource()) {
            return jedis.xpending(chatKey, LlmChatService.RESPONDER_GROUP).getTotal();
        }
    }

    private long dlqLen(String cid) {
        try (var jedis = jedisPool.getResource()) {
            String key = LlmChatService.dlqKey(cid);
            return jedis.exists(key) ? jedis.xlen(key) : 0;
        }
    }

    /** Highest delivery count the group ever recorded for a still-pending entry. */
    private long maxDeliveredTimes(String chatKey) {
        try (var jedis = jedisPool.getResource()) {
            return jedis.xpending(chatKey, LlmChatService.RESPONDER_GROUP,
                            redis.clients.jedis.params.XPendingParams.xPendingParams()
                                    .start(StreamEntryID.MINIMUM_ID)
                                    .end(StreamEntryID.MAXIMUM_ID).count(100)).stream()
                    .mapToLong(p -> p.getDeliveredTimes()).max().orElse(0);
        }
    }

    private void awaitUntil(Duration timeout, BooleanSupplier cond) {
        Instant deadline = Instant.now().plus(timeout);
        while (Instant.now().isBefore(deadline)) {
            if (cond.getAsBoolean()) {
                return;
            }
            settle(50);
        }
    }

    private static void settle(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /**
     * The teeth. One user message, a generation (~2.4s) far longer than {@code minIdle} (300ms), so
     * the sweeper reclaims the live entry roughly twenty times while the responder streams it.
     * Exactly one reply must reach the stream.
     *
     * <p>Verified able to fail, measured: with {@code isInFlight} stubbed to {@code false} this case
     * produced <strong>2</strong> identical replies for the one message, and the backlog case below
     * produced <strong>13</strong> for 8 — 3 of the 4 tests here go red.
     */
    @Test
    void aSlowGenerationIsNotRegeneratedWhileTheLiveResponderIsStillOnIt() {
        String cid = "dup-slow";
        String chatKey = LlmChatService.chatKey(cid);
        createGroup(chatKey);
        startWorkers(cid, 400);            // 6 word-tokens x 400ms = ~2.4s per reply

        postUser(chatKey, "one slow question", "u1");
        awaitUntil(Duration.ofSeconds(20), () -> !assistantReplies(chatKey).isEmpty());

        // A doubled generation starts *during* the first one, so it lands about a generation later.
        // Waiting past that point is what makes the assertion meaningful rather than merely early.
        settle(3000);

        assertThat(assistantReplies(chatKey))
                .as("one user message must produce exactly one reply")
                .hasSize(1);
        assertThat(pending(chatKey)).as("acked out of the PEL").isZero();
        assertThat(dlqLen(cid)).as("a healthy slow reply is not a poison message").isZero();
    }

    /**
     * The in-flight guard runs <em>before</em> the delivery-count check, so a generation slow enough
     * to be reclaimed more times than {@code maxDeliveries} must not be dead-lettered for being
     * slow. Pins the ordering inside {@code sweepOnce}.
     */
    @Test
    void aGenerationReclaimedMoreOftenThanMaxDeliveriesIsStillNotDeadLettered() {
        String cid = "dup-counter";
        String chatKey = LlmChatService.chatKey(cid);
        createGroup(chatKey);
        startWorkers(cid, 400);

        postUser(chatKey, "another slow question", "u1");
        // maxDeliveries is 2 and the sweep runs every 100ms, so the counter passes it within ~1s.
        awaitUntil(Duration.ofSeconds(10), () -> maxDeliveredTimes(chatKey) > 2);
        long reclaims = maxDeliveredTimes(chatKey);

        awaitUntil(Duration.ofSeconds(20), () -> !assistantReplies(chatKey).isEmpty());
        settle(1500);

        assertThat(reclaims).as("the sweeper did reclaim the live entry past maxDeliveries")
                .isGreaterThan(2);
        assertThat(dlqLen(cid)).as("slow is not poison").isZero();
        assertThat(assistantReplies(chatKey)).hasSize(1);
        assertThat(pending(chatKey)).isZero();
    }

    /**
     * A backlog on one conversation: the responder handles it serially while the sweeper reclaims
     * whichever entry is in flight. Every message must be answered exactly once — replies echo the
     * prompt, so a duplicate shows up as two identical contents.
     */
    @Test
    void aBacklogOnOneConversationNeverAnswersAMessageTwice() {
        String cid = "dup-backlog";
        String chatKey = LlmChatService.chatKey(cid);
        int messages = 8;
        createGroup(chatKey);
        startWorkers(cid, 120);            // ~0.7s per reply, still well past the 300ms minIdle

        for (int i = 1; i <= messages; i++) {
            postUser(chatKey, "question-" + i, "u" + i);
        }

        awaitUntil(Duration.ofSeconds(40), () -> assistantReplies(chatKey).size() >= messages);
        settle(2000);

        List<String> replies = assistantReplies(chatKey);
        assertThat(replies).as("one reply per message, no more").hasSize(messages);
        assertThat(replies).doesNotHaveDuplicates();
        for (int i = 1; i <= messages; i++) {
            String prompt = "question-" + i;
            assertThat(replies).anyMatch(r -> r.contains(prompt));
        }
        assertThat(pending(chatKey)).isZero();
        assertThat(dlqLen(cid)).isZero();
    }

    /**
     * The echo-based duplicate detection above is only valid while a user turn appears once, so this
     * pins that. <strong>It has no teeth for the guard itself</strong>: it stays green with
     * {@code isInFlight} stubbed to {@code false}, because the sweeper duplicates <em>replies</em>,
     * never the user entry it reclaims. Kept as a premise check, not as an audit case.
     */
    @Test
    void everyUserTurnRemainsInTheStreamExactlyOnce() {
        String cid = "dup-stream";
        String chatKey = LlmChatService.chatKey(cid);
        createGroup(chatKey);
        startWorkers(cid, 120);

        postUser(chatKey, "kept once", "u1");
        awaitUntil(Duration.ofSeconds(20), () -> !assistantReplies(chatKey).isEmpty());
        settle(1000);

        try (var jedis = jedisPool.getResource()) {
            List<StreamEntry> users = jedis
                    .xrange(chatKey, StreamEntryID.MINIMUM_ID, StreamEntryID.MAXIMUM_ID).stream()
                    .filter(e -> "user".equals(e.getFields().get("role")))
                    .toList();
            assertThat(users).hasSize(1);
            assertThat(users.get(0).getFields()).containsEntry("msgId", "u1");
        }
    }
}
