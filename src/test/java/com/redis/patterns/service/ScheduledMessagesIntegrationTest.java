package com.redis.patterns.service;

import com.redis.patterns.support.AbstractRedisIntegrationTest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.time.Duration;
import java.time.Instant;
import java.util.function.BooleanSupplier;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Integration tests for Scheduled/Delayed Messages: a Sorted Set keyed by due time, drained into a
 * stream by a poller.
 *
 * <p>The two properties that matter are symmetric — a message due in the future must <em>not</em> be
 * delivered early, and a due message must be delivered <em>and removed</em> (both from the zset and
 * its hash), so it cannot be delivered twice.
 *
 * <p>Spec: {@code docs/specs/scheduled-messages.md}.
 */
class ScheduledMessagesIntegrationTest extends AbstractRedisIntegrationTest {

    private ScheduledMessagesService service;
    private RedisStreamListenerService listener;

    @BeforeEach
    void startService() {
        listener = new RedisStreamListenerService(jedisPool, new WebSocketEventService(new ObjectMapper()));
        service = new ScheduledMessagesService(jedisPool, listener);
    }

    @AfterEach
    void stopService() {
        if (service != null) {
            service.stopScheduler();
        }
        if (listener != null) {
            listener.shutdown();
        }
    }

    @Test
    void aMessageDueInTheFutureIsNotDeliveredEarly() throws Exception {
        service.startScheduler();

        var msg = service.scheduleMessage("later", "not yet", System.currentTimeMillis() + 3_600_000);

        Thread.sleep(2_000); // several poll cycles (POLL_INTERVAL_MS is 500ms)
        assertThat(streamLength(ScheduledMessagesService.REMINDERS_STREAM))
            .as("nothing may be delivered before its due time")
            .isZero();
        try (var jedis = jedisPool.getResource()) {
            assertThat(jedis.zcard(ScheduledMessagesService.SCHEDULED_SET)).isEqualTo(1);
            assertThat(jedis.exists(ScheduledMessagesService.MESSAGE_PREFIX + msg.getId())).isTrue();
        }
    }

    @Test
    void aDueMessageIsDeliveredThenRemovedFromBothTheSetAndItsHash() throws Exception {
        service.startScheduler();

        var msg = service.scheduleMessage("now", "due already", System.currentTimeMillis() - 1_000);

        awaitTrue(() -> streamLength(ScheduledMessagesService.REMINDERS_STREAM) == 1,
                  Duration.ofSeconds(15), "the due message to be delivered");

        // Delivery and cleanup are two steps, not one: the poller XADDs to the stream and only then
        // ZREMs and deletes the hash. So this has to be awaited rather than asserted — and the same
        // window means a crash in between re-delivers the message, i.e. at-least-once.
        awaitTrue(() -> scheduledCount() == 0, Duration.ofSeconds(10),
                  "the delivered message to leave the schedule");

        try (var jedis = jedisPool.getResource()) {
            assertThat(jedis.exists(ScheduledMessagesService.MESSAGE_PREFIX + msg.getId()))
                .as("its payload hash is cleaned up too")
                .isFalse();
            var entry = jedis.xrange(ScheduledMessagesService.REMINDERS_STREAM, "-", "+", 10).get(0);
            assertThat(entry.getFields())
                .containsEntry("title", "now")
                .containsKeys("executedAt", "scheduledFor");
        }

        // and it stays delivered exactly once
        Thread.sleep(1_500);
        assertThat(streamLength(ScheduledMessagesService.REMINDERS_STREAM)).isEqualTo(1);
    }

    @Test
    void dueMessagesAreDeliveredInDueOrderNotInInsertionOrder() throws Exception {
        long now = System.currentTimeMillis();
        service.scheduleMessage("third", "", now - 1_000);
        service.scheduleMessage("first", "", now - 3_000);
        service.scheduleMessage("second", "", now - 2_000);

        service.startScheduler();

        awaitTrue(() -> streamLength(ScheduledMessagesService.REMINDERS_STREAM) == 3,
                  Duration.ofSeconds(15), "all three due messages to be delivered");

        try (var jedis = jedisPool.getResource()) {
            var titles = jedis.xrange(ScheduledMessagesService.REMINDERS_STREAM, "-", "+", 10).stream()
                .map(e -> e.getFields().get("title"))
                .toList();
            assertThat(titles)
                .as("the Sorted Set score is the due time, so the drain order is the due order")
                .containsExactly("first", "second", "third");
        }
    }

    @Test
    void deletingAScheduledMessagePreventsItsDelivery() throws Exception {
        var msg = service.scheduleMessage("cancelled", "", System.currentTimeMillis() + 2_000);
        service.deleteMessage(msg.getId());

        service.startScheduler();
        Thread.sleep(3_500); // past its due time

        assertThat(streamLength(ScheduledMessagesService.REMINDERS_STREAM)).isZero();
        assertThat(service.getAllScheduledMessages()).isEmpty();
    }

    private long scheduledCount() {
        try (var jedis = jedisPool.getResource()) {
            return jedis.zcard(ScheduledMessagesService.SCHEDULED_SET);
        }
    }

    private long streamLength(String stream) {
        try (var jedis = jedisPool.getResource()) {
            return jedis.exists(stream) ? jedis.xlen(stream) : 0L;
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
