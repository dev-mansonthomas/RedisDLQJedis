package com.redis.patterns.dto;

import tools.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** Verifies the LlmChatEvent JSON contract the frontend depends on. */
class LlmChatEventTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void serializesAndDeserializesAllFields() throws Exception {
        LlmChatEvent event = LlmChatEvent.builder()
                .eventType(LlmChatEvent.EventType.TOKEN)
                .conversationId("abc")
                .msgId("r1")
                .value("Hello")
                .streamId("1-0")
                .ts(1_700_000_000_000L)
                .build();

        String json = mapper.writeValueAsString(event);
        assertThat(json)
                .contains("\"eventType\":\"TOKEN\"")
                .contains("\"conversationId\":\"abc\"")
                .contains("\"msgId\":\"r1\"")
                .contains("\"value\":\"Hello\"")
                .contains("\"streamId\":\"1-0\"");

        LlmChatEvent back = mapper.readValue(json, LlmChatEvent.class);
        assertThat(back).isEqualTo(event);
    }
}
