package com.redis.patterns.controller;

import com.redis.patterns.service.WorkQueueService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.WebMvcTest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import java.util.List;
import java.util.Map;

import static org.hamcrest.Matchers.containsString;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** Contract tests for the runtime worker-pool endpoints and the reshaped /streams payload. */
@WebMvcTest(WorkQueueController.class)
class WorkQueueWorkersControllerTest {

    @Autowired
    private MockMvc mvc;

    @MockitoBean
    private WorkQueueService service;

    @Test
    void getWorkersReturnsCountBoundsAndConsumers() throws Exception {
        when(service.getWorkerState()).thenReturn(Map.of("count", 4, "min", 1, "max", 8));
        when(service.getConsumers()).thenReturn(List.of(
                Map.of("id", 1, "name", "worker-1", "doneStream", "jobs.done.worker-1")));

        mvc.perform(get("/work-queue/workers"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true))
                .andExpect(jsonPath("$.count").value(4))
                .andExpect(jsonPath("$.min").value(1))
                .andExpect(jsonPath("$.max").value(8))
                .andExpect(jsonPath("$.consumers[0].name").value("worker-1"));
    }

    @Test
    void addWorkerReturnsTheNewWorker() throws Exception {
        when(service.addWorker()).thenReturn(5);

        mvc.perform(post("/work-queue/workers"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true))
                .andExpect(jsonPath("$.count").value(5))
                .andExpect(jsonPath("$.added.id").value(5))
                .andExpect(jsonPath("$.added.name").value("worker-5"))
                .andExpect(jsonPath("$.added.doneStream").value("jobs.done.worker-5"));
    }

    @Test
    void addWorkerAtTheCeilingIsAConflict() throws Exception {
        when(service.addWorker()).thenThrow(new IllegalStateException("Worker count is already at the maximum (8)"));
        when(service.workerCount()).thenReturn(8);

        mvc.perform(post("/work-queue/workers"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.success").value(false))
                .andExpect(jsonPath("$.error").value(containsString("maximum")))
                .andExpect(jsonPath("$.count").value(8));
    }

    @Test
    void removeWorkerDefaultsToGraceful() throws Exception {
        when(service.removeWorker(false)).thenReturn(3);

        mvc.perform(delete("/work-queue/workers"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.kill").value(false))
                .andExpect(jsonPath("$.count").value(3))
                .andExpect(jsonPath("$.removed.id").value(4));

        verify(service).removeWorker(false);
    }

    @Test
    void killFlagIsPassedThroughAndTheConsumerIsKept() throws Exception {
        when(service.removeWorker(true)).thenReturn(1);

        mvc.perform(delete("/work-queue/workers").param("kill", "true"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.kill").value(true))
                .andExpect(jsonPath("$.removed.name").value("worker-2"))
                .andExpect(jsonPath("$.note").value(containsString("DELCONSUMER")));

        verify(service).removeWorker(true);
    }

    @Test
    void removeWorkerAtTheFloorIsAConflict() throws Exception {
        when(service.removeWorker(false))
                .thenThrow(new IllegalStateException("Worker count is already at the minimum (1)"));
        when(service.workerCount()).thenReturn(1);

        mvc.perform(delete("/work-queue/workers"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.success").value(false))
                .andExpect(jsonPath("$.error").value(containsString("minimum")));
    }

    @Test
    void streamsExposesDoneStreamsAsAnArrayPlusWorkerStateAndDemoMode() throws Exception {
        when(service.getStreamNames()).thenReturn(Map.of(
                "jobStream", "jobs.imageProcessing.v1",
                "dlqStream", "jobs.imageProcessing.v1:dlq",
                "group", "jobs-group",
                "doneStreams", List.of("jobs.done.worker-1", "jobs.done.worker-2")));
        when(service.getWorkerState()).thenReturn(Map.of("count", 2, "min", 1, "max", 8));
        when(service.getDemoModeState()).thenReturn(demoModeState());

        mvc.perform(get("/work-queue/streams"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.streams.group").value("jobs-group"))
                .andExpect(jsonPath("$.streams.doneStreams").isArray())
                .andExpect(jsonPath("$.streams.doneStreams[1]").value("jobs.done.worker-2"))
                .andExpect(jsonPath("$.workers.count").value(2))
                .andExpect(jsonPath("$.demoMode.mode").value("FAST"))
                .andExpect(jsonPath("$.demoMode.modes[0].name").value("SLOW"));
    }

    /** The dropdown is built from this payload, so every timing it prints must be in it. */
    @Test
    void getDemoModeReturnsTheActiveModeAndTheOptionsWithTheirTimings() throws Exception {
        when(service.getDemoModeState()).thenReturn(demoModeState());

        mvc.perform(get("/work-queue/demo-mode"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true))
                .andExpect(jsonPath("$.mode").value("FAST"))
                .andExpect(jsonPath("$.workMs").value(50))
                .andExpect(jsonPath("$.minIdleMs").value(500))
                .andExpect(jsonPath("$.modes[0].label").value("Slow"))
                .andExpect(jsonPath("$.modes[0].workMs").value(2000))
                .andExpect(jsonPath("$.modes[0].minIdleMs").value(5000))
                .andExpect(jsonPath("$.modes[0].producerSleepMs").value(2000));
    }

    @Test
    void putDemoModeAppliesTheModeAndReturnsTheNewTimings() throws Exception {
        when(service.applyDemoMode(WorkQueueService.DemoMode.SLOW))
                .thenReturn(Map.of("mode", "SLOW", "workMs", 2000L, "minIdleMs", 5000L));

        mvc.perform(put("/work-queue/demo-mode").param("mode", "SLOW"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true))
                .andExpect(jsonPath("$.mode").value("SLOW"))
                .andExpect(jsonPath("$.minIdleMs").value(5000));

        verify(service).applyDemoMode(WorkQueueService.DemoMode.SLOW);
    }

    /** Case-insensitive: the frontend sends whatever the descriptor's `name` was, so be lenient. */
    @Test
    void demoModeAcceptsLowerCase() throws Exception {
        when(service.applyDemoMode(WorkQueueService.DemoMode.FAST)).thenReturn(Map.of("mode", "FAST"));

        mvc.perform(put("/work-queue/demo-mode").param("mode", "fast"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.mode").value("FAST"));

        verify(service).applyDemoMode(WorkQueueService.DemoMode.FAST);
    }

    @Test
    void anUnknownDemoModeIsRejectedAndNamesTheAlternatives() throws Exception {
        mvc.perform(put("/work-queue/demo-mode").param("mode", "TURBO"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.success").value(false))
                .andExpect(jsonPath("$.error").value(containsString("SLOW")))
                .andExpect(jsonPath("$.error").value(containsString("FAST")));

        verify(service, never()).applyDemoMode(any());
    }

    @Test
    void burstReturnsItsBoundsRatherThanEveryId() throws Exception {
        when(service.produceBurst(200)).thenReturn(
                java.util.stream.IntStream.rangeClosed(1, 200).mapToObj(i -> i + "-0").toList());

        mvc.perform(post("/work-queue/produce/burst").param("count", "200"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.success").value(true))
                .andExpect(jsonPath("$.count").value(200))
                .andExpect(jsonPath("$.firstMessageId").value("1-0"))
                .andExpect(jsonPath("$.lastMessageId").value("200-0"));

        verify(service).produceBurst(200);
    }

    @Test
    void burstDefaultsTo200WhenNoCountIsGiven() throws Exception {
        when(service.produceBurst(200)).thenReturn(List.of("1-0"));

        mvc.perform(post("/work-queue/produce/burst")).andExpect(status().isOk());

        verify(service).produceBurst(200);
    }

    /** The bound lives in the service; the controller must surface it as a 400, not a 500. */
    @Test
    void anOutOfRangeBurstIsARequestError() throws Exception {
        when(service.produceBurst(5000))
                .thenThrow(new IllegalArgumentException("Burst size must be between 1 and 1000 (got 5000)"));

        mvc.perform(post("/work-queue/produce/burst").param("count", "5000"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.success").value(false))
                .andExpect(jsonPath("$.error").value(containsString("between 1 and 1000")));
    }

    /** Mirrors what the real service reports, so the assertions above pin the contract, not the mock. */
    private static Map<String, Object> demoModeState() {
        return Map.of(
                "mode", "FAST",
                "label", "Fast",
                "workMs", 50L,
                "minIdleMs", 500L,
                "pollMs", 50L,
                "producerSleepMs", 100L,
                "burstSize", 200,
                "modes", List.of(
                        WorkQueueService.DemoMode.SLOW.describe(),
                        WorkQueueService.DemoMode.FAST.describe()));
    }
}
