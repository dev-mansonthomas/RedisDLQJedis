package com.redis.patterns.service;

import com.redis.patterns.dto.DLQEvent;
import jakarta.annotation.PreDestroy;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.CommandLineRunner;
import org.springframework.stereotype.Service;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.StreamEntryID;
import redis.clients.jedis.params.XReadParams;
import redis.clients.jedis.resps.StreamEntry;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Service that listens to Redis Streams using XREAD BLOCK and broadcasts new messages via WebSocket.
 * 
 * This service implements the best practice for Redis Streams consumption:
 * - Uses XREAD BLOCK for efficient, push-like behavior
 * - Leverages Java 21 Virtual Threads for lightweight concurrency
 * - Automatically detects messages added externally (e.g., via Redis Insight)
 * - Broadcasts MESSAGE_PRODUCED events to Angular via WebSocket
 * 
 * Architecture:
 * - One Virtual Thread per monitored stream
 * - Blocking read with 1-second timeout
 * - Automatic reconnection on errors
 * - Graceful shutdown support
 * 
 * @author Redis Patterns Team
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class RedisStreamListenerService implements CommandLineRunner {

    private final JedisPool jedisPool;
    private final WebSocketEventService webSocketEventService;

    // Track which streams are being monitored
    private final Map<String, StreamMonitor> activeMonitors = new ConcurrentHashMap<>();
    
    // Shutdown flag
    private final AtomicBoolean shutdown = new AtomicBoolean(false);

    /**
     * Starts monitoring default streams on application startup.
     */
    @Override
    public void run(String... args) {
        log.info("Starting Redis Stream Listener Service with Virtual Threads");
        
        // Start monitoring default streams
        startMonitoring("test-stream");
        startMonitoring("test-stream:dlq");
        
        log.info("Redis Stream Listener Service started successfully");
    }

    /**
     * Starts monitoring a stream for new messages.
     * 
     * @param streamName Name of the stream to monitor
     */
    public void startMonitoring(String streamName) {
        if (activeMonitors.containsKey(streamName)) {
            log.debug("Stream '{}' is already being monitored", streamName);
            return;
        }

        log.info("Starting monitoring for stream '{}'", streamName);
        
        StreamMonitor monitor = new StreamMonitor(streamName);
        activeMonitors.put(streamName, monitor);
        
        // Start Virtual Thread for this stream
        Thread.ofVirtual()
            .name("stream-listener-" + streamName)
            .start(monitor);
        
        log.info("Virtual Thread started for stream '{}'", streamName);
    }

    /**
     * Stops monitoring a stream.
     * 
     * @param streamName Name of the stream to stop monitoring
     */
    public void stopMonitoring(String streamName) {
        StreamMonitor monitor = activeMonitors.remove(streamName);
        if (monitor != null) {
            monitor.stop();
            log.info("Stopped monitoring stream '{}'", streamName);
        }
    }

    /**
     * Stops all monitors and shuts down the service.
     */
    @PreDestroy
    public void shutdown() {
        log.info("Shutting down Redis Stream Listener Service");
        shutdown.set(true);
        
        activeMonitors.values().forEach(StreamMonitor::stop);
        activeMonitors.clear();
        
        log.info("Redis Stream Listener Service shut down successfully");
    }

    /**
     * Inner class that monitors a single stream using XREAD BLOCK.
     */
    private class StreamMonitor implements Runnable {
        private final String streamName;
        private final AtomicBoolean running = new AtomicBoolean(true);
        private StreamEntryID lastId;

        public StreamMonitor(String streamName) {
            this.streamName = streamName;
            // Start reading at "$" (LAST_ENTRY): only messages arriving after startup.
            // This avoids replaying the whole stream history on restart. The XREAD loop
            // advances lastId to each consumed entry's ID below.
            this.lastId = StreamEntryID.LAST_ENTRY;
        }

        public void stop() {
            running.set(false);
        }

        @Override
        public void run() {
            log.info("Stream monitor started for '{}'", streamName);
            
            while (running.get() && !shutdown.get()) {
                try (var jedis = jedisPool.getResource()) {
                    // XREAD BLOCK 1000 STREAMS <streamName> <lastId>
                    List<Map.Entry<String, List<StreamEntry>>> result = jedis.xread(
                        XReadParams.xReadParams()
                            .block(1000)  // Block for 1 second
                            .count(100),   // Read up to 100 messages at once
                        Collections.singletonMap(streamName, lastId)
                    );

                    // Process new messages
                    if (result != null && !result.isEmpty()) {
                        for (Map.Entry<String, List<StreamEntry>> streamEntries : result) {
                            for (StreamEntry entry : streamEntries.getValue()) {
                                // Update last ID
                                lastId = entry.getID();

                                // Broadcast MESSAGE_PRODUCED event
                                webSocketEventService.broadcastEvent(
                                    DLQEvent.builder()
                                        .eventType(DLQEvent.EventType.MESSAGE_PRODUCED)
                                        .messageId(entry.getID().toString())
                                        .payload(entry.getFields())
                                        .streamName(streamName)
                                        .details("New message detected by stream listener")
                                        .build()
                                );

                                log.debug("Detected new message in '{}': {}", streamName, entry.getID());
                            }
                        }
                    }

                } catch (Exception e) {
                    if (running.get() && !shutdown.get()) {
                        log.error("Error reading from stream '{}': {}", streamName, e.getMessage());

                        // Wait before retrying to avoid tight loop on persistent errors
                        try {
                            Thread.sleep(5000);
                        } catch (InterruptedException ie) {
                            Thread.currentThread().interrupt();
                            log.info("Stream monitor interrupted for '{}'", streamName);
                            break;
                        }
                    }
                }
            }

            log.info("Stream monitor stopped for '{}'", streamName);
        }
    }

    /**
     * Gets the list of currently monitored streams.
     *
     * @return Set of stream names being monitored
     */
    public Set<String> getMonitoredStreams() {
        return new HashSet<>(activeMonitors.keySet());
    }

    /**
     * Checks if a stream is being monitored.
     *
     * @param streamName Name of the stream
     * @return true if the stream is being monitored
     */
    public boolean isMonitoring(String streamName) {
        return activeMonitors.containsKey(streamName);
    }
}

