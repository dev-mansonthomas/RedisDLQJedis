package com.redis.patterns.controller;

import com.redis.patterns.service.LlmChatService;
import com.redis.patterns.service.LlmChatService.ChatTurn;
import com.redis.patterns.service.LlmChatService.GroupsInfo;
import com.redis.patterns.service.LlmChatService.MessagePosted;
import jakarta.validation.ConstraintViolationException;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * REST API for the LLM Chat pattern (#12). All paths sit under the {@code /api} context path.
 *
 * <p>CORS is governed by the application-wide allow-list ({@code CorsConfig}); no controller in
 * this project carries a per-endpoint {@code @CrossOrigin} wildcard.
 */
@Slf4j
@RestController
@RequestMapping("/llm-chat")
@RequiredArgsConstructor
@Validated
public class LlmChatController {

    private static final String CID_REGEX = "^[A-Za-z0-9:_-]{1,64}$";

    private final LlmChatService service;

    public record MessageRequest(@NotBlank @Size(max = 4000) String content) {}

    @PostMapping("/{cid}/message")
    public ResponseEntity<MessagePosted> postMessage(
            @PathVariable @Pattern(regexp = CID_REGEX) String cid,
            @Valid @RequestBody MessageRequest request) {
        return ResponseEntity.ok(service.postMessage(cid, request.content()));
    }

    @GetMapping("/{cid}/history")
    public ResponseEntity<List<ChatTurn>> history(@PathVariable @Pattern(regexp = CID_REGEX) String cid) {
        return ResponseEntity.ok(service.history(cid));
    }

    @GetMapping("/{cid}/groups")
    public ResponseEntity<GroupsInfo> groups(@PathVariable @Pattern(regexp = CID_REGEX) String cid) {
        return ResponseEntity.ok(service.groups(cid));
    }

    @GetMapping("/{cid}/token-series")
    public ResponseEntity<List<LlmChatService.SeriesPoint>> tokenSeries(
            @PathVariable @Pattern(regexp = CID_REGEX) String cid) {
        return ResponseEntity.ok(service.tokenSeries(cid));
    }

    @PostMapping("/{cid}/reset")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void reset(@PathVariable @Pattern(regexp = CID_REGEX) String cid) {
        service.reset(cid);
    }

    /** Demo crash: the next generation dies before XACK, so the sweeper recovers it via XAUTOCLAIM. */
    @PostMapping("/{cid}/kill-worker")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void killWorker(@PathVariable @Pattern(regexp = CID_REGEX) String cid) {
        service.killWorker(cid);
    }

    /** Invalid {@code cid} (path-variable constraint) or bad argument → 400 rather than 500. */
    @ExceptionHandler({ConstraintViolationException.class, IllegalArgumentException.class})
    public ResponseEntity<Map<String, String>> handleBadRequest(Exception e) {
        log.debug("Bad request: {}", e.getMessage());
        return ResponseEntity.badRequest().body(Map.of("error", e.getMessage()));
    }
}
