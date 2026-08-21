package com.redis.patterns.controller;

import com.redis.patterns.dto.ProcessOutcome;
import com.redis.patterns.service.DLQConfigService;
import com.redis.patterns.service.DLQMessagingService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.util.Map;

import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** Contract tests for POST /dlq/process: outcome parsing, legacy mapping, validation. */
@WebMvcTest(DLQController.class)
class DLQProcessControllerTest {

    @Autowired
    private MockMvc mvc;

    @MockitoBean
    private DLQMessagingService service;

    @MockitoBean
    private DLQConfigService configService;

    private void stub(ProcessOutcome outcome) {
        when(service.processNextMessage(outcome)).thenReturn(Map.of(
                "success", true, "outcome", outcome.name(), "messageId", "1-0"));
    }

    @Test
    void outcomeNackFailIsAcceptedAndEchoed() throws Exception {
        stub(ProcessOutcome.NACK_FAIL);

        mvc.perform(post("/dlq/process")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"outcome\":\"NACK_FAIL\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.outcome").value("NACK_FAIL"));

        verify(service).processNextMessage(ProcessOutcome.NACK_FAIL);
    }

    @Test
    void legacyShouldSucceedFalseMapsToNoAck() throws Exception {
        stub(ProcessOutcome.NO_ACK);

        mvc.perform(post("/dlq/process")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"shouldSucceed\":false}"))
                .andExpect(status().isOk());

        verify(service).processNextMessage(ProcessOutcome.NO_ACK);
    }

    @Test
    void emptyBodyDefaultsToAck() throws Exception {
        stub(ProcessOutcome.ACK);

        mvc.perform(post("/dlq/process")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isOk());

        verify(service).processNextMessage(ProcessOutcome.ACK);
    }

    @Test
    void invalidOutcomeIsRejectedWith400() throws Exception {
        mvc.perform(post("/dlq/process")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"outcome\":\"EXPLODE\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.success").value(false));

        verifyNoInteractions(service);
    }
}
