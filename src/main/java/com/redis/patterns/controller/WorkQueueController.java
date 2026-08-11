package com.redis.patterns.controller;

import com.redis.patterns.service.WorkQueueService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Arrays;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * REST Controller for Work Queue / Competing Consumers pattern.
 * 
 * Endpoints:
 * - POST /api/work-queue/produce - Produce a single job
 * - POST /api/work-queue/produce/burst - Produce N jobs at once (pipelined), to build a backlog
 * - GET /api/work-queue/streams - Get stream names for this pattern + worker-pool state + demo mode
 * - GET/POST/DELETE /api/work-queue/workers - Inspect / grow / shrink the worker pool
 * - GET/PUT /api/work-queue/demo-mode - Read / switch the demo pace (SLOW or FAST)
 */
@Slf4j
@RestController
@RequestMapping("/work-queue")
@RequiredArgsConstructor
@CrossOrigin(origins = "*")
public class WorkQueueController {

    private final WorkQueueService workQueueService;

    /**
     * Produce a single job to the job stream.
     * 
     * @param processingType "OK" for successful processing, "Error" for failed processing
     * @return Response with the produced message ID
     */
    @PostMapping("/produce")
    public ResponseEntity<Map<String, Object>> produceJob(
            @RequestParam(defaultValue = "OK") String processingType) {
        
        Map<String, Object> response = new HashMap<>();
        
        try {
            String jobId = WorkQueueService.newJobId();
            String messageId = workQueueService.produceJob(jobId, processingType, null);
            
            response.put("success", true);
            response.put("jobId", jobId);
            response.put("messageId", messageId);
            response.put("processingType", processingType);
            
            log.debug("Produced job {} (type={})", jobId, processingType);
            
            return ResponseEntity.ok(response);
            
        } catch (Exception e) {
            log.error("Failed to produce job", e);
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * Produce a burst of jobs in one pipelined round trip, to build a backlog the workers must drain.
     *
     * <p>POST /api/work-queue/produce/burst?count=200 → 400 when {@code count} is outside
     * 1..{@link WorkQueueService#MAX_BURST}. Every 10th job is an `Error`, like the page's own producer.
     *
     * <p>The response carries the bounds of the burst rather than all ids: at the maximum that would be
     * 1000 strings the UI has no use for.
     */
    @PostMapping("/produce/burst")
    public ResponseEntity<Map<String, Object>> produceBurst(
            @RequestParam(defaultValue = "200") int count) {

        Map<String, Object> response = new HashMap<>();
        try {
            java.util.List<String> messageIds = workQueueService.produceBurst(count);
            response.put("success", true);
            response.put("count", messageIds.size());
            response.put("firstMessageId", messageIds.getFirst());
            response.put("lastMessageId", messageIds.getLast());
            log.info("Burst of {} jobs produced", messageIds.size());
            return ResponseEntity.ok(response);
        } catch (IllegalArgumentException e) {
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.badRequest().body(response);
        } catch (Exception e) {
            log.error("Failed to produce a burst of {} jobs", count, e);
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * Get stream names used by this pattern, plus the current worker-pool state and demo mode.
     *
     * <p>{@code streams.doneStreams} is an array (one entry per running worker) rather than numbered
     * keys, because the worker count changes at runtime.
     */
    @GetMapping("/streams")
    public ResponseEntity<Map<String, Object>> getStreams() {
        Map<String, Object> response = new HashMap<>();
        response.put("success", true);
        response.put("streams", workQueueService.getStreamNames());
        response.put("workers", workQueueService.getWorkerState());
        response.put("demoMode", workQueueService.getDemoModeState());
        return ResponseEntity.ok(response);
    }

    /**
     * Current demo pace and the modes available, each with the timings the UI labels it with.
     *
     * GET /api/work-queue/demo-mode
     */
    @GetMapping("/demo-mode")
    public ResponseEntity<Map<String, Object>> getDemoMode() {
        Map<String, Object> response = new HashMap<>(workQueueService.getDemoModeState());
        response.put("success", true);
        return ResponseEntity.ok(response);
    }

    /**
     * Switch the demo pace. Idempotent, hence PUT.
     *
     * <p>PUT /api/work-queue/demo-mode?mode=SLOW → 400 with the accepted values when {@code mode} is
     * not one of them. The mode is parsed here rather than bound as an enum so the error names the
     * alternatives instead of returning Spring's bare 400.
     *
     * <p>Changing the mode moves the simulated work time and {@code minIdle} together — they are
     * coupled by an invariant (see {@code WorkQueueService.DemoMode}), so they are never exposed as
     * two independent knobs.
     */
    @PutMapping("/demo-mode")
    public ResponseEntity<Map<String, Object>> setDemoMode(@RequestParam String mode) {
        Map<String, Object> response = new HashMap<>();

        WorkQueueService.DemoMode parsed;
        try {
            parsed = WorkQueueService.DemoMode.valueOf(mode.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            response.put("success", false);
            response.put("error", "Unknown demo mode '" + mode + "'. Accepted values: "
                + Arrays.stream(WorkQueueService.DemoMode.values()).map(Enum::name).collect(Collectors.joining(", ")));
            return ResponseEntity.badRequest().body(response);
        }

        response.putAll(workQueueService.applyDemoMode(parsed));
        response.put("success", true);
        return ResponseEntity.ok(response);
    }

    /**
     * Current worker-pool state: count, bounds, and the consumers behind them.
     *
     * GET /api/work-queue/workers
     */
    @GetMapping("/workers")
    public ResponseEntity<Map<String, Object>> getWorkers() {
        Map<String, Object> response = new HashMap<>(workQueueService.getWorkerState());
        response.put("success", true);
        response.put("consumers", workQueueService.getConsumers());
        return ResponseEntity.ok(response);
    }

    /**
     * Add one worker to the pool.
     *
     * POST /api/work-queue/workers → 409 when already at the maximum.
     */
    @PostMapping("/workers")
    public ResponseEntity<Map<String, Object>> addWorker() {
        Map<String, Object> response = new HashMap<>();
        try {
            int count = workQueueService.addWorker();
            response.put("success", true);
            response.put("count", count);
            response.put("added", WorkQueueService.describeWorker(count));
            log.info("Added a worker; pool is now {}", count);
            return ResponseEntity.ok(response);
        } catch (IllegalStateException e) {
            return conflict(response, e);
        } catch (Exception e) {
            log.error("Failed to add a worker", e);
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /**
     * Remove the highest-id worker.
     *
     * <p>DELETE /api/work-queue/workers?kill=false → graceful: the in-flight job is completed first.
     * <br>DELETE /api/work-queue/workers?kill=true → abrupt: the in-flight job stays in the PEL and is
     * reclaimed by another worker (the crash-recovery demo). The consumer is never removed from the
     * group, since {@code XGROUP DELCONSUMER} would drop its pending entries.
     *
     * @return 409 when already at the minimum.
     */
    @DeleteMapping("/workers")
    public ResponseEntity<Map<String, Object>> removeWorker(
            @RequestParam(defaultValue = "false") boolean kill) {

        Map<String, Object> response = new HashMap<>();
        try {
            int count = workQueueService.removeWorker(kill);
            String removedName = WorkQueueService.consumerName(count + 1);
            response.put("success", true);
            response.put("count", count);
            response.put("kill", kill);
            response.put("removed", WorkQueueService.describeWorker(count + 1));
            response.put("note", "Consumer " + removedName + " kept in the group (no XGROUP DELCONSUMER) "
                + "so its pending entries stay claimable");
            log.info("Removed a worker ({}); pool is now {}", kill ? "killed" : "graceful", count);
            return ResponseEntity.ok(response);
        } catch (IllegalStateException e) {
            return conflict(response, e);
        } catch (Exception e) {
            log.error("Failed to remove a worker", e);
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }

    /** A pool bound was hit — the request is refused and the state is unchanged. */
    private ResponseEntity<Map<String, Object>> conflict(Map<String, Object> response, IllegalStateException e) {
        response.put("success", false);
        response.put("error", e.getMessage());
        response.put("count", workQueueService.workerCount());
        log.debug("Worker pool bound reached: {}", e.getMessage());
        return ResponseEntity.status(HttpStatus.CONFLICT).body(response);
    }

    /**
     * Clear all work queue streams and recreate consumer group.
     *
     * DELETE /api/work-queue/clear
     */
    @DeleteMapping("/clear")
    public ResponseEntity<Map<String, Object>> clearAllStreams() {
        Map<String, Object> response = new HashMap<>();

        try {
            workQueueService.clearAllStreams();

            response.put("success", true);
            response.put("message", "All streams cleared and consumer group recreated");

            log.info("Work queue streams cleared");

            return ResponseEntity.ok(response);

        } catch (Exception e) {
            log.error("Failed to clear streams", e);
            response.put("success", false);
            response.put("error", e.getMessage());
            return ResponseEntity.internalServerError().body(response);
        }
    }
}

