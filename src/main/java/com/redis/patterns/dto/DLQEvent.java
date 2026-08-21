package com.redis.patterns.dto;

import com.fasterxml.jackson.annotation.JsonFormat;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.LocalDateTime;
import java.util.Map;

/**
 * Data Transfer Object representing a DLQ event for real-time WebSocket streaming.
 * 
 * This class captures all relevant information about message processing events,
 * including successful processing, DLQ routing, and errors.
 * 
 * Events are sent to the frontend via WebSocket for real-time visualization.
 * 
 * @author Redis Patterns Team
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class DLQEvent {

    /**
     * Type of event that occurred
     */
    private EventType eventType;

    /**
     * Message ID from Redis Stream
     */
    private String messageId;

    /**
     * Message payload (field-value pairs)
     */
    private Map<String, String> payload;

    /**
     * Number of times this message has been delivered
     */
    private Long deliveryCount; // int64 like Redis' PEL counter — Long.MAX_VALUE = XNACK FATAL poison

    /**
     * Consumer that processed this message
     */
    private String consumer;

    /**
     * Timestamp when the event occurred
     */
    @JsonFormat(pattern = "yyyy-MM-dd'T'HH:mm:ss.SSS")
    @Builder.Default
    private LocalDateTime timestamp = LocalDateTime.now();

    /**
     * Additional details or error message
     */
    private String details;

    /**
     * Stream name where the event occurred
     */
    private String streamName;

    /**
     * Enum defining the types of DLQ events
     */
    public enum EventType {
        /**
         * Message was successfully reclaimed for processing
         */
        MESSAGE_RECLAIMED,

        /**
         * Message was successfully processed and acknowledged
         */
        MESSAGE_PROCESSED,

        /**
         * Message exceeded delivery threshold and was routed to DLQ
         */
        MESSAGE_TO_DLQ,

        /**
         * Message was explicitly released via XNACK (Redis 8.8+) — details carry the mode
         */
        MESSAGE_NACKED,

        /**
         * New message was produced to a stream
         */
        MESSAGE_PRODUCED,

        /**
         * Message was acknowledged (XACK). The entry <strong>remains in the stream</strong> — a
         * stream is a log, and {@code XACK} is not {@code XDEL}. Emitted by every worker that
         * finishes a message; consumers of this event must not remove it from a stream view.
         */
        MESSAGE_ACKED,

        /**
         * Message genuinely disappeared from a stream (deleted or trimmed). Only
         * {@code StreamMonitorService} can know this, by diffing the ids it has seen against the
         * ids the stream still holds.
         */
        MESSAGE_DELETED,

        /**
         * An error occurred during processing
         */
        ERROR,

        /**
         * Informational message (e.g., no pending messages)
         */
        INFO,

        /**
         * Test scenario started
         */
        TEST_STARTED,

        /**
         * Test scenario completed
         */
        TEST_COMPLETED,

        /**
         * High-volume test progress update
         */
        PROGRESS_UPDATE
    }
}

