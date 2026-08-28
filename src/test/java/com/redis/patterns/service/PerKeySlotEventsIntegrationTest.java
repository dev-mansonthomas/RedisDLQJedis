package com.redis.patterns.service;

import com.redis.patterns.dto.PerKeySlotEvent;
import com.redis.patterns.support.AbstractRedisIntegrationTest;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.JedisPoolConfig;
import tools.jackson.databind.ObjectMapper;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.BooleanSupplier;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The time-slot lanes can only be as truthful as these events, so the three phases are asserted
 * against a real Redis rather than trusted.
 *
 * <p>A recording subclass of the broadcaster is enough — the service is constructed by hand here, so
 * no Spring and no mocking library. The pool is sized like {@code PerKeySerializedIntegrationTest}'s:
 * three workers plus the stream listener outnumber the default pool.
 *
 * <p>Spec: {@code docs/specs/per-key-serialized.md}, section <em>Time-slot lanes</em>.
 */
class PerKeySlotEventsIntegrationTest extends AbstractRedisIntegrationTest {

    /** Captures what the service broadcasts. */
    static class RecordingWs extends WebSocketEventService {
        final List<PerKeySlotEvent> slots = new CopyOnWriteArrayList<>();

        RecordingWs() {
            super(new ObjectMapper());
        }

        @Override
        public void broadcastEvent(PerKeySlotEvent event) {
            slots.add(event);
        }
    }

    private JedisPool servicePool;
    private RecordingWs ws;
    private PerKeySerializedService service;
    private RedisStreamListenerService listener;

    @BeforeEach
    void startService() throws Exception {
        JedisPoolConfig config = new JedisPoolConfig();
        config.setMaxTotal(64);
        config.setMaxIdle(64);
        servicePool = new JedisPool(config, REDIS_HOST, redisPort);
        // The lock is released through the registered `release_lock` function, so the library must be
        // loaded or every lock survives until its 30s TTL and same-key throughput collapses.
        try (var jedis = servicePool.getResource()) {
            jedis.functionLoadReplace(Files.readString(Path.of("lua/stream_utils.lua")));
        }
        ws = new RecordingWs();
        listener = new RedisStreamListenerService(servicePool, ws);
        service = new PerKeySerializedService(servicePool, ws, listener);
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
    void aProcessedJobEmitsStartedThenFinished() throws Exception {
        service.submitJobs(List.of(Map.of("orderId", "#7001", "action", "validate")));

        awaitTrue(() -> phases("#7001").contains(PerKeySlotEvent.Phase.FINISHED),
                Duration.ofSeconds(30), "the job to finish");

        List<PerKeySlotEvent.Phase> phases = phases("#7001");
        assertThat(phases).startsWith(PerKeySlotEvent.Phase.STARTED);
        assertThat(phases).contains(PerKeySlotEvent.Phase.FINISHED);

        PerKeySlotEvent started = forKey("#7001").getFirst();
        assertThat(started.getWorkerId()).isBetween(1, 3);
        assertThat(started.getAction()).isEqualTo("validate");
        assertThat(started.getMessageId()).isNotBlank();
        assertThat(started.getAtMs()).isGreaterThan(0L);
    }

    @Test
    void startedPrecedesTheProcessingWindow_notTrailingIt() throws Exception {
        // STARTED must be emitted BEFORE the 2700ms sleep, or a running job only appears once it is
        // over and the grid can never show occupancy.
        long submittedAt = System.currentTimeMillis();
        service.submitJobs(List.of(Map.of("orderId", "#7002", "action", "validate")));

        awaitTrue(() -> !forKey("#7002").isEmpty(), Duration.ofSeconds(15), "the STARTED event");

        PerKeySlotEvent started = forKey("#7002").getFirst();
        assertThat(started.getPhase()).isEqualTo(PerKeySlotEvent.Phase.STARTED);
        assertThat(started.getAtMs() - submittedAt)
                .as("STARTED lands well inside the 2700ms processing window, not after it")
                .isLessThan(2_000L);
    }

    @Test
    void aWorkerRefusedTheKeyEmitsLockSkipped() throws Exception {
        // Five jobs on ONE key against three workers: whichever way the group hands them out, a
        // worker other than the holder must be turned away.
        service.submitJobs(List.of(
                Map.of("orderId", "#7003", "action", "a"),
                Map.of("orderId", "#7003", "action", "b"),
                Map.of("orderId", "#7003", "action", "c"),
                Map.of("orderId", "#7003", "action", "d"),
                Map.of("orderId", "#7003", "action", "e")));

        awaitTrue(() -> phases("#7003").contains(PerKeySlotEvent.Phase.LOCK_SKIPPED),
                Duration.ofSeconds(30), "a refused lock");

        PerKeySlotEvent skipped = forKey("#7003").stream()
                .filter(e -> e.getPhase() == PerKeySlotEvent.Phase.LOCK_SKIPPED)
                .findFirst().orElseThrow();
        assertThat(skipped.getWorkerId()).isBetween(1, 3);
        assertThat(skipped.getOrderId()).isEqualTo("#7003");
    }

    private List<PerKeySlotEvent> forKey(String key) {
        return ws.slots.stream().filter(e -> key.equals(e.getOrderId())).toList();
    }

    private List<PerKeySlotEvent.Phase> phases(String key) {
        return forKey(key).stream().map(PerKeySlotEvent::getPhase).toList();
    }

    /** Local poller — Awaitility is not a dependency of this project and must not become one. */
    private void awaitTrue(BooleanSupplier condition, Duration timeout, String what)
            throws InterruptedException {
        long deadline = System.currentTimeMillis() + timeout.toMillis();
        while (System.currentTimeMillis() < deadline) {
            if (condition.getAsBoolean()) return;
            Thread.sleep(50);
        }
        throw new AssertionError("Timed out waiting for " + what);
    }
}
