package com.redis.patterns.controller;

import com.redis.patterns.service.RequestReplyService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.Map;

/**
 * REST Controller for Request/Reply pattern operations.
 *
 * This controller is INDEPENDENT from DLQ and PubSub features.
 * It provides endpoints for sending requests and receiving responses.
 *
 * Note: The context path is /api (configured in application.yml),
 * so this endpoint is accessible at /api/request-reply
 */
@Slf4j
@RestController
@RequestMapping("/request-reply")
@RequiredArgsConstructor
public class RequestReplyController {

    private final RequestReplyService requestReplyService;

    /**
     * Send a request and return the correlation ID.
     * 
     * @param request Request payload containing orderId and items
     * @return Response with success flag and correlation ID
     */
    @PostMapping("/send")
    public ResponseEntity<Map<String, Object>> sendRequest(@RequestBody Map<String, Object> request) {
        log.info("Received request: {}", request);
        
        try {
            String correlationId = requestReplyService.sendRequest(request);
            
            return ResponseEntity.ok(Map.of(
                "success", true,
                "correlationId", correlationId
            ));
        } catch (Exception e) {
            log.error("Error sending request", e);
            return ResponseEntity.internalServerError()
                .body(Map.of(
                    "success", false,
                    "error", e.getMessage()
                ));
        }
    }
}

