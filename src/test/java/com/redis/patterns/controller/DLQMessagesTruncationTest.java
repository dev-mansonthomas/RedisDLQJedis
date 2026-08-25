package com.redis.patterns.controller;

import com.redis.patterns.service.DLQConfigService;
import com.redis.patterns.service.DLQMessagingService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;
import java.util.Map;
import java.util.stream.IntStream;

import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * Contract test for GET /dlq/messages: a truncated page must say so.
 *
 * <p>{@code count} is the size of the page, which is all the endpoint used to report — so a viewer
 * holding 5 of 11 entries was told the stream held 5, and rendered "5 of 5 messages" over a stream
 * of 11. The page cannot detect its own truncation from a number that is capped by the page size, so
 * the stream's real length travels alongside it.
 */
@WebMvcTest(DLQController.class)
class DLQMessagesTruncationTest {

    @Autowired
    private MockMvc mvc;

    @MockitoBean
    private DLQMessagingService service;

    @MockitoBean
    private DLQConfigService configService;

    @Test
    void aTruncatedPageReportsTheStreamsRealLength() throws Exception {
        when(service.readMessages(anyString(), anyInt())).thenReturn(page(5));
        when(service.getStreamLength("jobs.perkey.v1")).thenReturn(11L);

        mvc.perform(get("/dlq/messages").param("streamName", "jobs.perkey.v1").param("count", "5"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.count").value(5))            // the page
                .andExpect(jsonPath("$.streamLength").value(11));   // the stream
    }

    @Test
    void anUntruncatedPageReportsTheSameNumberTwice() throws Exception {
        when(service.readMessages(anyString(), anyInt())).thenReturn(page(3));
        when(service.getStreamLength("test-stream")).thenReturn(3L);

        mvc.perform(get("/dlq/messages").param("streamName", "test-stream").param("count", "20"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.count").value(3))
                .andExpect(jsonPath("$.streamLength").value(3));
    }

    private List<Map<String, Object>> page(int size) {
        return IntStream.range(0, size)
                .mapToObj(i -> Map.<String, Object>of("id", i + "-0", "fields", Map.of("k", "v")))
                .toList();
    }
}
