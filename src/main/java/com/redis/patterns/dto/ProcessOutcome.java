package com.redis.patterns.dto;

import redis.clients.jedis.args.XNackMode;

/**
 * Outcome applied to the next message read by the DLQ demo's process action.
 *
 * <p>The three NACK outcomes map to the Redis 8.8+ {@code XNACK} modes and differ by what they do
 * to the failure budget (the PEL delivery counter checked against {@code maxDeliveries}):
 * <ul>
 *   <li>{@link #ACK} — processing succeeded, message acknowledged.</li>
 *   <li>{@link #NO_ACK} — implicit failure (simulated crash): stays owned, retried only after
 *       {@code minIdleMs}, budget consumed.</li>
 *   <li>{@link #NACK_FAIL} — explicit failure: released immediately, budget consumed.</li>
 *   <li>{@link #NACK_FATAL} — poison: counter forced to {@code Long.MAX_VALUE}, swept to the DLQ
 *       by the next poll without waiting {@code minIdleMs}.</li>
 *   <li>{@link #NACK_SILENT} — returned untouched (e.g. graceful shutdown): released immediately,
 *       counter reset to 0 — the budget is refunded.</li>
 * </ul>
 */
public enum ProcessOutcome {
    ACK, NO_ACK, NACK_FAIL, NACK_FATAL, NACK_SILENT;

    /** XNACK mode for NACK_* outcomes, {@code null} for ACK / NO_ACK. */
    public XNackMode xnackMode() {
        return switch (this) {
            case NACK_FAIL -> XNackMode.FAIL;
            case NACK_FATAL -> XNackMode.FATAL;
            case NACK_SILENT -> XNackMode.SILENT;
            case ACK, NO_ACK -> null;
        };
    }

    /** Maps the legacy {@code shouldSucceed} request flag. */
    public static ProcessOutcome fromLegacy(boolean shouldSucceed) {
        return shouldSucceed ? ACK : NO_ACK;
    }
}
