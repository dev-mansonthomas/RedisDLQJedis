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
import java.util.function.BooleanSupplier;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Integration tests for the Token Bucket (concurrency cap) pattern: a Lua counter grants at most
 * {@code maxConcurrency} tokens per job type, and a worker that cannot get one leaves its message
 * pending instead of failing it.
 *
 * <p>That last detail is what makes this pattern worth an integration test. A message waiting for a
 * token accumulates idle time, so it is eventually re-delivered through {@code XAUTOCLAIM} — the
 * claim path, with 18 workers competing in a single group. {@code docs/TODO.md} flagged this pattern
 * as never audited for the duplicate-processing failure mode that cost the Work Queue 120 of 266
 * jobs; {@link #saturatingTheBucketDoesNotProcessAnyJobTwice()} is that audit.
 *
 * <p>Spec: {@code docs/specs/token-bucket.md}.
 */
class TokenBucketIntegrationTest extends AbstractRedisIntegrationTest {

    private JedisPool servicePool;
    private TokenBucketService service;
    private RedisStreamListenerService listener;

    @BeforeEach
    void startService() throws Exception {
        JedisPoolConfig config = new JedisPoolConfig();
        config.setMaxTotal(128);
        config.setMaxIdle(128);
        servicePool = new JedisPool(config, REDIS_HOST, redisPort);
        try (var jedis = servicePool.getResource()) {
            jedis.functionLoadReplace(Files.readString(Path.of("lua/stream_utils.lua")));
        }
        var ws = new WebSocketEventService(new ObjectMapper());
        listener = new RedisStreamListenerService(servicePool, ws);
        service = new TokenBucketService(servicePool, ws, listener);
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
    void theRunningCounterNeverExceedsTheConfiguredCap() throws Exception {
        service.submitJobs("payment", 8); // cap 3, 4s each

        long observedMax = sampleMaxRunning("payment", Duration.ofSeconds(14));

        assertThat(observedMax)
            .as("the cap is the whole point: 8 jobs, at most 3 in flight")
            .isPositive()
            .isLessThanOrEqualTo(3);
    }

    @Test
    void loweringTheCapAtRuntimeIsHonouredByTheNextAcquisitions() throws Exception {
        service.updateConfig("payment", 1);

        service.submitJobs("payment", 4);
        long observedMax = sampleMaxRunning("payment", Duration.ofSeconds(12));

        assertThat(observedMax)
            .as("the cap is read from Redis on every acquisition, so a runtime change applies at once")
            .isEqualTo(1);
    }

    @Test
    void saturatingTheBucketDoesNotProcessAnyJobTwice() throws Exception {
        int jobs = 12; // 12 payment jobs, cap 3, 4s each -> ~16s, well past RECLAIM_MIN_IDLE_MS (15s)
        service.submitJobs("payment", jobs);

        awaitTrue(() -> doneJobIds().size() >= jobs, Duration.ofSeconds(90),
                  "all " + jobs + " jobs to complete");
        Thread.sleep(3_000); // let a late duplicate surface

        List<String> ids = doneJobIds();
        assertThat(ids)
            .as("queued jobs sit in the PEL until a token frees up, so they cross the 15s idle "
                + "threshold and come back through XAUTOCLAIM — with 18 workers in one group, a "
                + "duplicate here is the Work Queue's silent double-processing all over again")
            .doesNotHaveDuplicates();
        assertThat(ids).hasSize(jobs);
        assertThat(pendingCount()).as("nothing left owned by a dead consumer").isZero();
        assertThat(runningCount("payment"))
            .as("every token taken was given back, or the bucket would leak and deadlock the type")
            .isZero();
    }

    @Test
    void tokensAreReleasedSoLaterJobsStillGetThrough() throws Exception {
        service.submitJobs("payment", 4);
        awaitTrue(() -> doneJobIds().size() >= 4, Duration.ofSeconds(60), "the first batch");

        assertThat(runningCount("payment")).isZero();

        service.submitJobs("payment", 2);
        awaitTrue(() -> doneJobIds().size() >= 6, Duration.ofSeconds(60), "the second batch");

        assertThat(doneJobIds()).hasSize(6).doesNotHaveDuplicates();
    }

    @Test
    void eachJobTypeHasItsOwnBucketSoOneTypeCannotStarveAnother() throws Exception {
        service.submitJobs("payment", 4); // cap 3
        service.submitJobs("email", 4);   // cap 2

        long paymentMax = 0;
        long emailMax = 0;
        Instant deadline = Instant.now().plus(Duration.ofSeconds(14));
        while (Instant.now().isBefore(deadline)) {
            paymentMax = Math.max(paymentMax, runningCount("payment"));
            emailMax = Math.max(emailMax, runningCount("email"));
            Thread.sleep(100);
        }

        assertThat(paymentMax).as("payment cap").isPositive().isLessThanOrEqualTo(3);
        assertThat(emailMax).as("email cap, independent of payment's").isPositive().isLessThanOrEqualTo(2);
    }

    private long sampleMaxRunning(String jobType, Duration window) throws Exception {
        long max = 0;
        Instant deadline = Instant.now().plus(window);
        while (Instant.now().isBefore(deadline)) {
            max = Math.max(max, runningCount(jobType));
            Thread.sleep(100);
        }
        return max;
    }

    private long runningCount(String jobType) {
        try (var jedis = servicePool.getResource()) {
            String value = jedis.get("token-bucket:running:" + jobType);
            return value == null ? 0 : Long.parseLong(value);
        }
    }

    private List<String> doneJobIds() {
        try (var jedis = servicePool.getResource()) {
            if (!jedis.exists(TokenBucketService.DONE_STREAM)) {
                return List.of();
            }
            return jedis.xrange(TokenBucketService.DONE_STREAM, (StreamEntryID) null, (StreamEntryID) null, 1000)
                .stream().map(e -> e.getFields().get("jobId")).toList();
        }
    }

    private long pendingCount() {
        try (var jedis = servicePool.getResource()) {
            var info = jedis.xpending(TokenBucketService.JOB_STREAM, TokenBucketService.JOB_GROUP);
            return info == null ? 0 : info.getTotal();
        }
    }

    private void awaitTrue(BooleanSupplier condition, Duration timeout, String what) throws Exception {
        Instant deadline = Instant.now().plus(timeout);
        while (Instant.now().isBefore(deadline)) {
            if (condition.getAsBoolean()) {
                return;
            }
            Thread.sleep(200);
        }
        throw new AssertionError("Timed out waiting for " + what);
    }
}
