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
 * Integration tests for Fan-Out (broadcast).
 *
 * <p>The distinction from the Work Queue is the whole point and is easy to get backwards: Fan-Out
 * gives each worker its <em>own consumer group</em>, so every worker sees every event — whereas
 * competing consumers share one group and see each event once. These tests pin both halves: every
 * event reaches all four groups, and no event is processed twice <em>within</em> a group.
 *
 * <p>Spec: {@code docs/specs/fan-out.md}.
 */
class FanOutIntegrationTest extends AbstractRedisIntegrationTest {

    private static final int WORKERS = 4;

    private JedisPool servicePool;
    private FanOutService service;
    private RedisStreamListenerService listener;

    @BeforeEach
    void startService() throws Exception {
        JedisPoolConfig config = new JedisPoolConfig();
        config.setMaxTotal(64);
        config.setMaxIdle(64);
        servicePool = new JedisPool(config, REDIS_HOST, redisPort);
        try (var jedis = servicePool.getResource()) {
            jedis.functionLoadReplace(Files.readString(Path.of("lua/stream_utils.lua")));
        }
        var ws = new WebSocketEventService(new ObjectMapper());
        listener = new RedisStreamListenerService(servicePool, ws);
        service = new FanOutService(servicePool, listener);
        service.run();
    }

    @AfterEach
    void stopService() {
        if (service != null) {
            service.stopWorkers();
        }
        if (listener != null) {
            listener.shutdown();
        }
        if (servicePool != null) {
            servicePool.close();
        }
    }

    @Test
    void oneGroupPerWorkerIsCreated() {
        try (var jedis = servicePool.getResource()) {
            var groups = jedis.xinfoGroups(FanOutService.FANOUT_STREAM).stream()
                .map(g -> g.getName()).toList();
            assertThat(groups).hasSize(WORKERS);
            for (int i = 1; i <= WORKERS; i++) {
                assertThat(groups).contains(FanOutService.FANOUT_GROUP_PREFIX + i);
            }
        }
    }

    @Test
    void everyWorkerReceivesEveryEventExactlyOnce() throws Exception {
        int events = 6;
        for (int i = 1; i <= events; i++) {
            service.produceEvent("EVT-" + i, "OK", Map.of());
        }

        awaitTrue(() -> allDoneStreamsHaveAtLeast(events), Duration.ofSeconds(30),
                  "all " + WORKERS + " workers to process all " + events + " events");

        for (int worker = 1; worker <= WORKERS; worker++) {
            List<String> ids = eventIdsIn(FanOutService.FANOUT_DONE_PREFIX + worker);
            assertThat(ids)
                .as("worker %d must see all %d events — this is broadcast, not a work queue",
                    worker, events)
                .hasSize(events);
            assertThat(ids)
                .as("worker %d must not process the same event twice: with MIN_IDLE_MS (100ms) equal "
                    + "to the processing sleep (100ms), a second consumer in the same group would "
                    + "steal in-flight work — this pattern is safe only because each group has one",
                    worker)
                .doesNotHaveDuplicates();
        }
    }

    @Test
    void aFailingEventIsNotAckedAndEventuallyReachesTheDlq() throws Exception {
        service.produceEvent("EVT-POISON", "ERROR", Map.of());

        awaitTrue(() -> streamLength(FanOutService.FANOUT_DLQ) >= 1, Duration.ofSeconds(30),
                  "the failing event to reach the DLQ");

        // Broadcast means every group fails it independently, so the DLQ can hold up to one entry
        // per group. What matters is that no worker reported it as done.
        for (int worker = 1; worker <= WORKERS; worker++) {
            assertThat(eventIdsIn(FanOutService.FANOUT_DONE_PREFIX + worker))
                .as("worker %d must not mark a failing event as done", worker)
                .doesNotContain("EVT-POISON");
        }
    }

    private boolean allDoneStreamsHaveAtLeast(int n) {
        for (int worker = 1; worker <= WORKERS; worker++) {
            if (streamLength(FanOutService.FANOUT_DONE_PREFIX + worker) < n) {
                return false;
            }
        }
        return true;
    }

    private List<String> eventIdsIn(String stream) {
        try (var jedis = servicePool.getResource()) {
            if (!jedis.exists(stream)) {
                return List.of();
            }
            return jedis.xrange(stream, (StreamEntryID) null, (StreamEntryID) null, 1000).stream()
                .map(e -> e.getFields().get("eventId"))
                .toList();
        }
    }

    private long streamLength(String stream) {
        try (var jedis = servicePool.getResource()) {
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
