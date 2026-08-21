package com.redis.patterns.service;

import com.redis.patterns.support.AbstractRedisIntegrationTest;
import org.junit.jupiter.api.Test;
import redis.clients.jedis.JedisPubSub;
import tools.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Integration tests for the Pub/Sub pattern (QoS 0, fire-and-forget).
 *
 * <p>The point of this pattern is what it does <em>not</em> do: a message published with nobody
 * listening is gone. That is the property worth pinning, because it is the one a reader is most
 * likely to assume away.
 */
class PubSubIntegrationTest extends AbstractRedisIntegrationTest {

    private static final String CHANNEL = "fire-and-forget";

    private PubSubService service() {
        return new PubSubService(jedisPool, new WebSocketEventService(new ObjectMapper()));
    }

    @Test
    void publishingWithNoSubscriberReachesNobodyAndStoresNothing() {
        long delivered = service().publishMessage(CHANNEL, Map.of("type", "order", "id", "1"));

        assertThat(delivered).as("PUBLISH returns the number of clients that received it").isZero();
        try (var jedis = jedisPool.getResource()) {
            assertThat(jedis.dbSize())
                .as("fire-and-forget: Pub/Sub is not a stream, nothing is persisted")
                .isZero();
        }
    }

    @Test
    void everySubscriberOfTheChannelGetsTheMessage() throws Exception {
        List<String> received = new CopyOnWriteArrayList<>();
        CountDownLatch latch = new CountDownLatch(2);
        List<JedisPubSub> subs = new CopyOnWriteArrayList<>();

        for (int i = 0; i < 2; i++) {
            JedisPubSub sub = new JedisPubSub() {
                @Override
                public void onMessage(String channel, String message) {
                    received.add(message);
                    latch.countDown();
                }
            };
            subs.add(sub);
            // subscribe() blocks, so each subscriber needs its own thread and its own connection
            Thread.ofVirtual().name("pubsub-test-sub-" + i).start(() -> subscribeQuietly(sub, CHANNEL));
        }
        awaitSubscribers(2);

        long delivered = service().publishMessage(CHANNEL, Map.of("type", "order", "id", "42"));

        assertThat(delivered).as("both subscribers counted by PUBLISH").isEqualTo(2);
        assertThat(latch.await(5, TimeUnit.SECONDS)).as("both subscribers received it").isTrue();
        assertThat(received).hasSize(2);
        // The wire format is deliberately not JSON: PubSubService.serializePayload writes
        // comma-separated key=value pairs, and deserializePayload reads them back.
        assertThat(received.get(0)).contains("id=42").contains("type=order");
        assertThat(service().deserializePayload(received.get(0)))
            .containsEntry("id", "42")
            .containsEntry("type", "order");
        subs.forEach(JedisPubSub::unsubscribe);
    }

    @Test
    void aSubscriberOnAnotherChannelIsNotDisturbed() throws Exception {
        List<String> onOtherChannel = new CopyOnWriteArrayList<>();
        JedisPubSub sub = new JedisPubSub() {
            @Override
            public void onMessage(String channel, String message) {
                onOtherChannel.add(message);
            }
        };
        Thread.ofVirtual().start(() -> subscribeQuietly(sub, "some-other-channel"));
        awaitSubscribers(1);

        long delivered = service().publishMessage(CHANNEL, Map.of("id", "7"));

        assertThat(delivered).as("the other channel's subscriber is not a recipient").isZero();
        Thread.sleep(300); // give a wrong delivery time to show up
        assertThat(onOtherChannel).isEmpty();
        sub.unsubscribe();
    }

    /**
     * {@code subscribe()} blocks until unsubscribed, then the pooled connection is closed under it —
     * which surfaces as a connection exception that says nothing about the test. Swallow it.
     */
    private void subscribeQuietly(JedisPubSub sub, String channel) {
        try (var jedis = jedisPool.getResource()) {
            jedis.subscribe(sub, channel);
        } catch (RuntimeException expectedAtTeardown) {
            // no-op
        }
    }

    /** PUBLISH returns 0 until Redis has actually registered the SUBSCRIBEs. */
    private void awaitSubscribers(int expected) throws InterruptedException {
        for (int i = 0; i < 100; i++) {
            try (var jedis = jedisPool.getResource()) {
                long total = jedis.pubsubChannels().stream()
                    .mapToLong(c -> jedis.pubsubNumSub(c).values().stream().mapToLong(Long::longValue).sum())
                    .sum();
                if (total >= expected) {
                    return;
                }
            }
            Thread.sleep(50);
        }
        throw new IllegalStateException("subscribers never registered");
    }
}
