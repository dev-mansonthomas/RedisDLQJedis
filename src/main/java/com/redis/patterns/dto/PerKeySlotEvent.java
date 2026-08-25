package com.redis.patterns.dto;

import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * One state change in the Per-Key Serialized demo: a worker started a job, finished one, or was
 * refused a key another worker held.
 *
 * <p>A dedicated DTO rather than a new {@code DLQEvent.EventType}: {@code DLQEvent} is consumed by
 * {@code stream-viewer} on all twelve pattern pages, and its payload (payload / deliveryCount /
 * failureKind) has nothing to do with worker occupancy. Same precedent as {@code PubSubEvent}.
 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
public class PerKeySlotEvent {

    /**
     * Discriminator. Every event on this socket carries one, and consumers filter on it before
     * touching any other field.
     */
    @Builder.Default
    private String eventType = "PER_KEY_SLOT";

    private Phase phase;

    /** 1..NUM_WORKERS — the grid column. */
    private int workerId;

    /** The business key (an orderId). Drives the cell's background colour. */
    private String orderId;

    private String action;

    /** Correlates a STARTED with its FINISHED. */
    private String messageId;

    /**
     * Epoch millis, deliberately not a {@code LocalDateTime}: the frontend does arithmetic on this
     * (slot binning, interval overlap), and a zone-less local time is ambiguous for that. The other
     * DTOs keep {@code @JsonFormat} because they only ever display their timestamp.
     */
    private long atMs;

    public enum Phase {
        /** Lock acquired; work is about to begin. Emitted BEFORE the simulated processing. */
        STARTED,
        /** Work done and copied to the worker's done stream. */
        FINISHED,
        /** The key was held by another worker, so this one moved on without blocking. */
        LOCK_SKIPPED
    }
}
