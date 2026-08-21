package com.redis.patterns.controller;

import tools.jackson.databind.ObjectMapper;
import com.redis.patterns.service.LlmChatService;
import com.redis.patterns.service.LlmChatService.ChatTurn;
import com.redis.patterns.service.LlmChatService.GroupsInfo;
import com.redis.patterns.service.LlmChatService.MessagePosted;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;

import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** Endpoint contract tests: status codes, validation, and payload shape. */
@WebMvcTest(LlmChatController.class)
class LlmChatControllerTest {

    @Autowired
    private MockMvc mvc;

    @Autowired
    private ObjectMapper mapper;

    @MockitoBean
    private LlmChatService service;

    @Test
    void postMessageReturnsPostedMessage() throws Exception {
        when(service.postMessage(eq("conv1"), eq("hello")))
                .thenReturn(new MessagePosted("conv1", "m1", "1-0"));

        mvc.perform(post("/llm-chat/conv1/message")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"hello\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.msgId").value("m1"))
                .andExpect(jsonPath("$.streamId").value("1-0"));
    }

    @Test
    void blankContentIsRejected() throws Exception {
        mvc.perform(post("/llm-chat/conv1/message")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"  \"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void oversizeContentIsRejected() throws Exception {
        String body = mapper.writeValueAsString(new LlmChatController.MessageRequest("a".repeat(4001)));
        mvc.perform(post("/llm-chat/conv1/message")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isBadRequest());
    }

    @Test
    void invalidCidIsRejected() throws Exception {
        mvc.perform(post("/llm-chat/bad$id/message")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"hi\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void historyReturnsArray() throws Exception {
        when(service.history("conv1"))
                .thenReturn(List.of(new ChatTurn("1-0", "user", "hi", 1L, "m1", null)));

        mvc.perform(get("/llm-chat/conv1/history"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$[0].role").value("user"))
                .andExpect(jsonPath("$[0].content").value("hi"));
    }

    @Test
    void groupsReturnsObject() throws Exception {
        when(service.groups("conv1"))
                .thenReturn(new GroupsInfo("chat:conv1", 2, "chat:conv1:tok", 5, List.of(),
                        List.of(), java.util.Map.of(), "chat:conv1:dlq", List.of()));

        mvc.perform(get("/llm-chat/conv1/groups"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.stream").value("chat:conv1"))
                .andExpect(jsonPath("$.length").value(2));
    }

    @Test
    void resetReturnsNoContent() throws Exception {
        mvc.perform(post("/llm-chat/conv1/reset"))
                .andExpect(status().isNoContent());
        verify(service).reset("conv1");
    }

    @Test
    void killWorkerReturnsNoContent() throws Exception {
        mvc.perform(post("/llm-chat/conv1/kill-worker"))
                .andExpect(status().isNoContent());
        verify(service).killWorker("conv1");
    }
}
