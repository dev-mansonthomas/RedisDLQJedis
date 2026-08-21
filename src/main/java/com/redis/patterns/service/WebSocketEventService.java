package com.redis.patterns.service;

import tools.jackson.databind.ObjectMapper;
import com.redis.patterns.dto.DLQEvent;
import com.redis.patterns.dto.LlmChatEvent;
import com.redis.patterns.dto.PubSubEvent;
import jakarta.annotation.PreDestroy;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArraySet;

/**
 * Service for broadcasting DLQ events to WebSocket clients in real-time.
 * 
 * This service maintains a registry of active WebSocket sessions and
 * broadcasts events to all connected clients. It handles:
 * - Session registration and removal
 * - Event serialization to JSON
 * - Error handling for failed broadcasts
 * - Thread-safe session management
 * 
 * The service uses concurrent collections to ensure thread-safety
 * when multiple threads are broadcasting events simultaneously.
 * 
 * @author Redis Patterns Team
 */
@Service
@RequiredArgsConstructor
public class WebSocketEventService {

    private static final Logger log = LoggerFactory.getLogger(WebSocketEventService.class);

    /**
     * WebSocket session attribute holding the conversation id a client subscribed to (pattern #12).
     * LLM chat events are delivered only to sessions whose attribute matches the event's cid, so one
     * conversation's content is not fanned out to every connected client.
     */
    public static final String LLM_CID_ATTRIBUTE = "llmCid";

    private final ObjectMapper objectMapper;
    
    // Thread-safe set of active WebSocket sessions
    private final Set<WebSocketSession> sessions = new CopyOnWriteArraySet<>();
    
    // Track session statistics
    private final ConcurrentHashMap<String, Long> sessionStats = new ConcurrentHashMap<>();

    /**
     * Flipped on context close. The Redis listener Virtual Threads outlive the WebSocket sessions
     * Spring is already tearing down, so a broadcast attempted after this point is expected to
     * fail -- it is shutdown noise, not an incident.
     */
    private final AtomicBoolean shuttingDown = new AtomicBoolean(false);

    @PreDestroy
    void stopBroadcasting() {
        shuttingDown.set(true);
    }

    /** @return true once the application context is closing. */
    public boolean isShuttingDown() {
        return shuttingDown.get();
    }

    /**
     * Registers a new WebSocket session.
     * 
     * @param session The WebSocket session to register
     */
    public void registerSession(WebSocketSession session) {
        sessions.add(session);
        sessionStats.put(session.getId(), 0L);
        log.info("WebSocket session registered: {} (Total active: {})", 
            session.getId(), sessions.size());
    }

    /**
     * Removes a WebSocket session.
     * 
     * @param session The WebSocket session to remove
     */
    public void removeSession(WebSocketSession session) {
        sessions.remove(session);
        Long messageCount = sessionStats.remove(session.getId());
        log.info("WebSocket session removed: {} (Sent {} messages, Remaining active: {})", 
            session.getId(), messageCount, sessions.size());
    }

    /**
     * Broadcasts an event to all connected WebSocket clients.
     * 
     * This method:
     * 1. Serializes the event to JSON
     * 2. Sends it to all active sessions
     * 3. Removes sessions that fail to receive the message
     * 4. Logs statistics about the broadcast
     * 
     * The method is thread-safe and can be called from multiple threads.
     * 
     * @param event The DLQ event to broadcast
     */
    public void broadcastEvent(DLQEvent event) {
        if (shuttingDown.get()) {
            log.debug("Shutting down, dropping DLQEvent broadcast");
            return;
        }
        if (sessions.isEmpty()) {
            log.trace("No active WebSocket sessions, skipping broadcast");
            return;
        }

        try {
            // Serialize event to JSON
            String message = objectMapper.writeValueAsString(event);
            if (message == null) {
                log.error("Failed to serialize event to JSON");
                return;
            }
            TextMessage textMessage = new TextMessage(message);
            
            log.debug("Broadcasting event to {} sessions: {}", sessions.size(), event.getEventType());
            
            // Send to all sessions
            int successCount = 0;
            int failureCount = 0;
            
            for (WebSocketSession session : sessions) {
                try {
                    if (session.isOpen()) {
                        // Synchronize on the session to prevent concurrent writes
                        synchronized (session) {
                            session.sendMessage(textMessage);
                        }
                        sessionStats.merge(session.getId(), 1L, (oldValue, newValue) -> oldValue + newValue);
                        successCount++;
                    } else {
                        // Session is closed, remove it
                        sessions.remove(session);
                        sessionStats.remove(session.getId());
                        failureCount++;
                        log.debug("Removed closed session: {}", session.getId());
                    }
                } catch (IOException e) {
                    // Failed to send, remove the session
                    sessions.remove(session);
                    sessionStats.remove(session.getId());
                    failureCount++;
                    log.warn("Failed to send message to session {}, removing it", session.getId(), e);
                }
            }
            
            if (log.isTraceEnabled()) {
                log.trace("Broadcast complete: {} successful, {} failed", successCount, failureCount);
            }
            
        } catch (Exception e) {
            log.error("Failed to broadcast event", e);
        }
    }

    /**
     * Gets the number of active WebSocket sessions.
     * 
     * @return Number of active sessions
     */
    public int getActiveSessionCount() {
        return sessions.size();
    }

    /**
     * Gets statistics for all sessions.
     *
     * @return Map of session ID to message count
     */
    public ConcurrentHashMap<String, Long> getSessionStats() {
        return new ConcurrentHashMap<>(sessionStats);
    }

    /**
     * Broadcasts a Pub/Sub event to all connected WebSocket clients.
     *
     * This method is similar to broadcastEvent(DLQEvent) but handles PubSubEvent objects.
     *
     * @param event The Pub/Sub event to broadcast
     */
    public void broadcastEvent(PubSubEvent event) {
        if (shuttingDown.get()) {
            log.debug("Shutting down, dropping PubSubEvent broadcast");
            return;
        }
        if (sessions.isEmpty()) {
            log.trace("No active WebSocket sessions, skipping broadcast");
            return;
        }

        try {
            // Serialize event to JSON
            String message = objectMapper.writeValueAsString(event);
            if (message == null) {
                log.error("Failed to serialize PubSubEvent to JSON");
                return;
            }
            TextMessage textMessage = new TextMessage(message);

            log.debug("Broadcasting PubSubEvent to {} sessions: {}", sessions.size(), event.getEventType());

            // Send to all sessions
            int successCount = 0;
            int failureCount = 0;

            for (WebSocketSession session : sessions) {
                try {
                    if (session.isOpen()) {
                        // Synchronize on the session to prevent concurrent writes
                        synchronized (session) {
                            session.sendMessage(textMessage);
                        }
                        sessionStats.merge(session.getId(), 1L, (oldValue, newValue) -> oldValue + newValue);
                        successCount++;
                    } else {
                        // Session is closed, remove it
                        sessions.remove(session);
                        sessionStats.remove(session.getId());
                        failureCount++;
                        log.debug("Removed closed session: {}", session.getId());
                    }
                } catch (IOException e) {
                    // Failed to send, remove the session
                    sessions.remove(session);
                    sessionStats.remove(session.getId());
                    failureCount++;
                    log.warn("Failed to send message to session {}, removing it", session.getId(), e);
                }
            }

            if (log.isTraceEnabled()) {
                log.trace("Broadcast complete: {} successful, {} failed", successCount, failureCount);
            }

        } catch (Exception e) {
            log.error("Failed to broadcast PubSubEvent", e);
        }
    }

    /**
     * Broadcasts an LLM Chat event (pattern #12) to all connected WebSocket clients.
     *
     * <p>Same broadcast-and-prune mechanics as the other overloads; clients filter by
     * {@code conversationId}.
     *
     * @param event The LLM chat event to broadcast
     */
    public void broadcastEvent(LlmChatEvent event) {
        if (shuttingDown.get()) {
            log.debug("Shutting down, dropping LlmChatEvent broadcast");
            return;
        }
        if (sessions.isEmpty()) {
            log.trace("No active WebSocket sessions, skipping broadcast");
            return;
        }

        try {
            String message = objectMapper.writeValueAsString(event);
            if (message == null) {
                log.error("Failed to serialize LlmChatEvent to JSON");
                return;
            }
            TextMessage textMessage = new TextMessage(message);

            log.debug("Broadcasting LlmChatEvent to {} sessions: {}", sessions.size(), event.getEventType());

            int successCount = 0;
            int failureCount = 0;

            for (WebSocketSession session : sessions) {
                // Confidentiality: only deliver to sessions that subscribed to THIS conversation id,
                // instead of fanning every conversation's content out to all connected clients.
                Object subscribed = session.getAttributes().get(LLM_CID_ATTRIBUTE);
                if (subscribed == null || !subscribed.equals(event.getConversationId())) {
                    continue;
                }
                try {
                    if (session.isOpen()) {
                        synchronized (session) {
                            session.sendMessage(textMessage);
                        }
                        sessionStats.merge(session.getId(), 1L, Long::sum);
                        successCount++;
                    } else {
                        sessions.remove(session);
                        sessionStats.remove(session.getId());
                        failureCount++;
                        log.debug("Removed closed session: {}", session.getId());
                    }
                } catch (IOException e) {
                    sessions.remove(session);
                    sessionStats.remove(session.getId());
                    failureCount++;
                    log.warn("Failed to send message to session {}, removing it", session.getId(), e);
                }
            }

            if (log.isTraceEnabled()) {
                log.trace("LlmChat broadcast complete: {} successful, {} failed", successCount, failureCount);
            }

        } catch (Exception e) {
            log.error("Failed to broadcast LlmChatEvent", e);
        }
    }
}

