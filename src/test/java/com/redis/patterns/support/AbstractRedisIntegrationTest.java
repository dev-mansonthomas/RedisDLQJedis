package com.redis.patterns.support;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import redis.clients.jedis.JedisPool;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Base class for integration tests that need a real Redis instance.
 *
 * <p>Streams, consumer groups, {@code XPENDING} and {@code XINFO} semantics cannot be faithfully
 * mocked, so these tests run against a throwaway {@code redis:8.8-alpine} container (matching the
 * app's Redis version). The container is started once per test class and the keyspace is flushed
 * before each test for isolation.
 *
 * <p>We drive the container with the {@code docker} CLI rather than Testcontainers: the bundled
 * docker-java client negotiates Docker API v1.32, which modern engines (min v1.40) reject, whereas
 * the CLI works everywhere Docker itself does. When Docker is unavailable every subclass test is
 * <em>skipped</em> (JUnit assumption), so pure unit tests still run in Docker-less environments.
 */
public abstract class AbstractRedisIntegrationTest {

    private static final String IMAGE = "redis:8.8-alpine";

    private static String containerId;
    protected static JedisPool jedisPool;

    /** Host/port of the throwaway container, for tests that need their own pool (e.g. a larger one). */
    protected static final String REDIS_HOST = "127.0.0.1";
    protected static int redisPort;

    @BeforeAll
    static void startRedis() {
        assumeTrue(dockerAvailable(), "Docker is not available; skipping Redis integration tests");

        // Bind container 6379 to a random localhost port so parallel runs never collide.
        containerId = run("docker", "run", "-d", "--rm", "-p", "127.0.0.1::6379", IMAGE);
        assumeTrue(containerId != null && !containerId.isBlank(), "Could not start Redis container");

        redisPort = mappedPort(containerId);
        jedisPool = new JedisPool(REDIS_HOST, redisPort);
        awaitReady(Duration.ofSeconds(30));
    }

    @AfterAll
    static void stopRedis() {
        if (jedisPool != null) {
            jedisPool.close();
            jedisPool = null;
        }
        if (containerId != null) {
            run("docker", "rm", "-f", containerId);
            containerId = null;
        }
    }

    @BeforeEach
    void flushRedis() {
        try (var jedis = jedisPool.getResource()) {
            jedis.flushAll();
        }
    }

    private static boolean dockerAvailable() {
        try {
            Process p = new ProcessBuilder("docker", "version", "--format", "{{.Server.Version}}")
                    .redirectErrorStream(true).start();
            return p.waitFor() == 0;
        } catch (Exception e) {
            return false;
        }
    }

    /** Resolves the host port docker mapped to the container's 6379. */
    private static int mappedPort(String id) {
        String mapping = run("docker", "port", id, "6379/tcp"); // e.g. "127.0.0.1:49153"
        if (mapping == null || !mapping.contains(":")) {
            throw new IllegalStateException("Unexpected 'docker port' output: " + mapping);
        }
        String portPart = mapping.substring(mapping.lastIndexOf(':') + 1).trim();
        return Integer.parseInt(portPart);
    }

    private static void awaitReady(Duration timeout) {
        Instant deadline = Instant.now().plus(timeout);
        RuntimeException last = null;
        while (Instant.now().isBefore(deadline)) {
            try (var jedis = jedisPool.getResource()) {
                if ("PONG".equals(jedis.ping())) {
                    return;
                }
            } catch (RuntimeException e) {
                last = e;
            }
            try {
                Thread.sleep(200);
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        throw new IllegalStateException("Redis container did not become ready in time", last);
    }

    /** Runs a command, returns trimmed stdout (first line), or null on non-zero exit. */
    private static String run(String... command) {
        try {
            Process p = new ProcessBuilder(command).redirectErrorStream(true).start();
            List<String> lines = new ArrayList<>();
            try (BufferedReader r = new BufferedReader(
                    new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) {
                    lines.add(line);
                }
            }
            int exit = p.waitFor();
            if (exit != 0) {
                return null;
            }
            return lines.isEmpty() ? "" : lines.get(0).trim();
        } catch (Exception e) {
            return null;
        }
    }
}
