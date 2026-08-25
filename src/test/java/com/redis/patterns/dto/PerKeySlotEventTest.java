package com.redis.patterns.dto;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The wire shape is the contract with the browser, so it is asserted rather than assumed.
 *
 * <p>{@code atMs} in particular must stay a JSON *number*: the frontend bins it into slots and
 * compares intervals, and a quoted timestamp would silently become string arithmetic.
 */
class PerKeySlotEventTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void serialisesWithANumericTimestampAndTheDiscriminator() {
        PerKeySlotEvent event = PerKeySlotEvent.builder()
                .phase(PerKeySlotEvent.Phase.STARTED)
                .workerId(2)
                .orderId("#1001")
                .action("recalculateTotal")
                .messageId("1787-0")
                .atMs(1_787_000_000_123L)
                .build();

        String json = mapper.writeValueAsString(event);

        assertThat(json).contains("\"eventType\":\"PER_KEY_SLOT\"");
        assertThat(json).contains("\"phase\":\"STARTED\"");
        assertThat(json).contains("\"atMs\":1787000000123");
        assertThat(json).doesNotContain("\"atMs\":\"");
    }

    @Test
    void carriesTheDiscriminatorForEveryPhase() {
        for (PerKeySlotEvent.Phase phase : PerKeySlotEvent.Phase.values()) {
            PerKeySlotEvent event = PerKeySlotEvent.builder().phase(phase).workerId(1)
                    .orderId("#1").action("a").messageId("m").atMs(1L).build();
            assertThat(event.getEventType()).isEqualTo("PER_KEY_SLOT");
        }
    }
}
