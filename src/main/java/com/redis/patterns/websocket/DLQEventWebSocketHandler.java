package com.redis.patterns.websocket;

import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import com.redis.patterns.service.WebSocketEventService;
import lombok.RequiredArgsConstructor;
import org.springframework.lang.NonNull;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * WebSocket handler for DLQ events.
 * 
 * This handler manages the lifecycle of WebSocket connections:
 * - Registers new connections with the event service
 * - Handles incoming messages (if needed)
 * - Cleans up connections when they close
 * - Handles errors gracefully
 * 
 * The handler extends TextWebSocketHandler to work with text-based
 * JSON messages for event streaming.
 * 
 * @author Redis Patterns Team
 */
@Component
@RequiredArgsConstructor
public class DLQEventWebSocketHandler extends TextWebSocketHandler {

    private static final Logger log = LoggerFactory.getLogger(DLQEventWebSocketHandler.class);
    /** Same shape as the server-side cid validation, so we never store a malformed subscription. */
    private static final Pattern CID_PATTERN = Pattern.compile("^[A-Za-z0-9:_-]{1,64}$");

    private final Set<WebSocketSession> sessions = ConcurrentHashMap.newKeySet();
    private final WebSocketEventService webSocketEventService;
    private final ObjectMapper objectMapper;

    /**
     * Called when a new WebSocket connection is established.
     *
     * Registers the session with the event service so it can
     * receive broadcast events.
     *
     * @param session The new WebSocket session
     * @throws Exception if registration fails
     */
    @Override
    public void afterConnectionEstablished(@NonNull WebSocketSession session) throws Exception {
        log.info("New WebSocket connection established: {}", session.getId());
        webSocketEventService.registerSession(session);

        // Send a welcome message
        session.sendMessage(new TextMessage(
            "{\"eventType\":\"INFO\",\"details\":\"Connected to DLQ event stream\",\"timestamp\":\"" +
            java.time.LocalDateTime.now() + "\"}"
        ));
    }

    /**
     * Called when a WebSocket connection is closed.
     *
     * Removes the session from the event service to prevent
     * attempts to send messages to a closed connection.
     *
     * @param session The closed WebSocket session
     * @param status The close status
     * @throws Exception if cleanup fails
     */
    @Override
    public void afterConnectionClosed(@NonNull WebSocketSession session, @NonNull CloseStatus status) throws Exception {
        log.info("WebSocket connection closed: {} (Status: {})", session.getId(), status);
        webSocketEventService.removeSession(session);
    }

    /**
     * Called when an error occurs on the WebSocket connection.
     *
     * Logs the error and removes the session to prevent further issues.
     *
     * @param session The WebSocket session with an error
     * @param exception The exception that occurred
     * @throws Exception if error handling fails
     */
    @Override
    public void handleTransportError(@NonNull WebSocketSession session, @NonNull Throwable exception) throws Exception {
        if (webSocketEventService.isShuttingDown()) {
            // Context closing: Spring tears the sessions down under us. Expected, not an incident.
            log.debug("WebSocket transport error for session {} during shutdown", session.getId());
        } else {
            log.error("WebSocket transport error for session {}", session.getId(), exception);
        }
        webSocketEventService.removeSession(session);
    }

    /**
     * Called when a text message is received from the client.
     *
     * Currently, this is a one-way stream (server to client), but this
     * method can be extended to handle client commands if needed.
     *
     * @param session The WebSocket session
     * @param message The received message
     * @throws Exception if message handling fails
     */
    @Override
    protected void handleTextMessage(@NonNull WebSocketSession session, @NonNull TextMessage message) throws Exception {
        String payload = message.getPayload();
        log.debug("Received message from client {}: {}", session.getId(), payload);

        // LLM Chat (#12) clients send {"type":"subscribe","cid":"..."} to receive only their own
        // conversation's events. We record the cid on the session; broadcastEvent(LlmChatEvent)
        // then delivers matching events only. Malformed frames are ignored.
        try {
            JsonNode node = objectMapper.readTree(payload);
            if ("subscribe".equals(node.path("type").asText())) {
                String cid = node.path("cid").asText(null);
                if (cid != null && CID_PATTERN.matcher(cid).matches()) {
                    session.getAttributes().put(WebSocketEventService.LLM_CID_ATTRIBUTE, cid);
                    log.debug("Session {} subscribed to LLM conversation {}", session.getId(), cid);
                }
            }
        } catch (Exception e) {
            log.debug("Ignoring non-JSON/unhandled client message from {}", session.getId());
        }
    }
}

