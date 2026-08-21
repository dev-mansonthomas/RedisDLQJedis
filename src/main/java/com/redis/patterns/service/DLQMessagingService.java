package com.redis.patterns.service;

import com.redis.patterns.config.DLQProperties;
import com.redis.patterns.dto.DLQConfigRequest;
import com.redis.patterns.dto.DLQEvent;
import com.redis.patterns.dto.DLQMessage;
import com.redis.patterns.dto.DLQParameters;
import com.redis.patterns.dto.DLQResponse;
import com.redis.patterns.dto.ProcessOutcome;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import redis.clients.jedis.JedisPool;
import redis.clients.jedis.StreamEntryID;
import redis.clients.jedis.args.XNackMode;
import redis.clients.jedis.params.XAddParams;
import redis.clients.jedis.params.XReadGroupParams;
import redis.clients.jedis.resps.StreamEntry;

import java.util.*;

/**
 * Service implementing the Dead Letter Queue (DLQ) messaging pattern.
 * 
 * This service provides comprehensive DLQ functionality including:
 * - Message production to streams
 * - Claiming and processing pending messages
 * - Automatic routing to DLQ based on delivery thresholds
 * - Consumer group management
 * - Real-time event broadcasting via WebSocket
 * 
 * The service uses the claim_or_dlq Lua function for atomic operations,
 * ensuring consistency and performance.
 * 
 * Best Practices Implemented:
 * - Connection pooling for optimal performance
 * - Comprehensive error handling and logging
 * - Resource cleanup with try-with-resources
 * - Thread-safe operations
 * - Detailed event tracking for monitoring
 * 
 * @author Redis Patterns Team
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class DLQMessagingService {

    private final JedisPool jedisPool;
    private final DLQProperties dlqProperties;
    private final WebSocketEventService webSocketEventService;
    private final DLQConfigService dlqConfigService;

    // Redis 8.4.0+ function that uses XREADGROUP CLAIM
    private static final String FUNCTION_NAME = "read_claim_or_dlq";
    private static final String LIBRARY_NAME = "stream_utils";

    /**
     * Initializes the consumer group for a stream if it doesn't exist.
     * 
     * This method ensures the consumer group is ready before any message consumption.
     * If the group already exists, the error is logged but not thrown.
     * 
     * @param streamName Name of the stream
     * @param groupName Name of the consumer group
     * @throws RuntimeException if group creation fails for reasons other than already existing
     */
    public void initializeConsumerGroup(String streamName, String groupName) {
        log.info("Initializing consumer group '{}' for stream '{}'", groupName, streamName);
        
        try (var jedis = jedisPool.getResource()) {
            try {
                // Create the group at 0-0 (the beginning of the stream): new StreamEntryID()
                // encodes to "0-0". This is intentional for the demo — messages are produced
                // BEFORE the group is created, and creating the group at 0-0 ensures those
                // already-present messages are still delivered to the group (creating at "$"
                // would skip them).
                jedis.xgroupCreate(streamName, groupName, new StreamEntryID(), true);
                log.info("Consumer group '{}' created successfully", groupName);
                
                // Broadcast event
                webSocketEventService.broadcastEvent(DLQEvent.builder()
                    .eventType(DLQEvent.EventType.INFO)
                    .streamName(streamName)
                    .details("Consumer group '" + groupName + "' initialized")
                    .build());
                    
            } catch (Exception e) {
                if (e.getMessage() != null && e.getMessage().contains("BUSYGROUP")) {
                    log.info("Consumer group '{}' already exists", groupName);
                } else {
                    log.error("Failed to create consumer group '{}'", groupName, e);
                    throw new RuntimeException("Failed to initialize consumer group", e);
                }
            }
        } catch (Exception e) {
            log.error("Error accessing Redis", e);
            throw new RuntimeException("Failed to connect to Redis", e);
        }
    }

    /**
     * Produces a message to the specified stream.
     *
     * Messages are added with auto-generated IDs and can contain multiple field-value pairs.
     *
     * NOTE: This method no longer broadcasts MESSAGE_PRODUCED events directly.
     * The RedisStreamListenerService (using XREAD BLOCK) will automatically detect
     * new messages and broadcast them via WebSocket. This ensures that messages
     * added externally (e.g., via Redis Insight) are also detected and displayed.
     *
     * @param streamName Name of the stream
     * @param payload Message payload as field-value pairs
     * @return The generated message ID
     * @throws RuntimeException if message production fails
     */
    public String produceMessage(String streamName, Map<String, String> payload) {
        log.debug("Producing message to stream '{}': {}", streamName, payload);

        try (var jedis = jedisPool.getResource()) {
            // Add message with auto-generated ID (*)
            StreamEntryID messageId = jedis.xadd(streamName, XAddParams.xAddParams(), payload);

            log.debug("Message produced with ID: {} (will be detected by stream listener)", messageId);

            // NOTE: No WebSocket broadcast here - RedisStreamListenerService handles it
            // This ensures consistent behavior for all messages (API + external)

            return messageId.toString();

        } catch (Exception e) {
            log.error("Failed to produce message to stream '{}'", streamName, e);
            throw new RuntimeException("Failed to produce message", e);
        }
    }

    /**
     * Executes the claim_or_dlq Lua function to process pending messages.
     *
     * This is the core DLQ operation that:
     * 1. Identifies pending messages that have been idle for minIdleMs
     * 2. Checks their delivery count
     * 3. Reclaims messages below the threshold for reprocessing
     * 4. Routes messages at/above the threshold to the DLQ
     *
     * The operation is atomic, ensuring consistency even under high concurrency.
     *
     * @param params DLQ parameters for the operation
     * @return Response containing operation results
     * @throws RuntimeException if the operation fails
     */
    public DLQResponse claimOrDLQ(DLQParameters params) {
        log.info("Executing claim_or_dlq with params: {}", params);

        try (var jedis = jedisPool.getResource()) {
            // Call the Lua function
            // KEYS: [stream, dlq_stream]
            // ARGS: [group, consumer, minIdle, count, maxDeliveries]
            Object result = jedis.fcall(
                FUNCTION_NAME,
                Arrays.asList(params.getStreamName(), params.getDlqStreamName()),
                Arrays.asList(
                    params.getConsumerGroup(),
                    params.getConsumerName(),
                    String.valueOf(params.getMinIdleMs()),
                    String.valueOf(params.getCount()),
                    String.valueOf(params.getMaxDeliveries())
                )
            );

            // Parse the Lua return contract: [messages_to_process, dlq_ids]
            //   element[0] = messages to process (new + reclaimed pending), as [id, fields] entries
            //   element[1] = messages routed to DLQ, as [originalId, newDlqId] pairs
            List<String> messageIdsToProcess = new ArrayList<>();
            List<String> dlqIds = new ArrayList<>();
            int messagesToProcess = 0;
            int messagesSentToDLQ = 0;

            if (result instanceof List) {
                @SuppressWarnings("unchecked")
                List<Object> resultList = (List<Object>) result;

                // First element: messages to process (new + reclaimed)
                if (resultList.size() > 0 && resultList.get(0) instanceof List) {
                    @SuppressWarnings("unchecked")
                    List<Object> toProcessList = (List<Object>) resultList.get(0);

                    for (Object entry : toProcessList) {
                        if (entry instanceof List) {
                            @SuppressWarnings("unchecked")
                            List<Object> entryList = (List<Object>) entry;

                            if (!entryList.isEmpty()) {
                                String messageId = entryList.get(0).toString();
                                messageIdsToProcess.add(messageId);
                                messagesToProcess++;

                                // Parse payload if available
                                Map<String, String> payload = new HashMap<>();
                                if (entryList.size() > 1 && entryList.get(1) instanceof List) {
                                    @SuppressWarnings("unchecked")
                                    List<Object> fields = (List<Object>) entryList.get(1);
                                    for (int i = 0; i < fields.size(); i += 2) {
                                        if (i + 1 < fields.size()) {
                                            payload.put(fields.get(i).toString(), fields.get(i + 1).toString());
                                        }
                                    }
                                }

                                // Don't broadcast events here (display is driven by the stream listener)
                            }
                        }
                    }
                }

                // Second element: messages sent to DLQ
                if (resultList.size() > 1 && resultList.get(1) instanceof List) {
                    @SuppressWarnings("unchecked")
                    List<Object> dlqList = (List<Object>) resultList.get(1);

                    for (Object entry : dlqList) {
                        if (entry instanceof List) {
                            @SuppressWarnings("unchecked")
                            List<Object> entryList = (List<Object>) entry;

                            if (entryList.size() >= 3) {
                                String originalId = entryList.get(0).toString();
                                // newDlqId is at entryList.get(2) but not needed here
                                // RedisStreamListenerService will detect it automatically
                                dlqIds.add(originalId);
                                messagesSentToDLQ++;

                                // Tell the UI it was acked — the entry stays in the main stream
                                webSocketEventService.broadcastEvent(DLQEvent.builder()
                                    .eventType(DLQEvent.EventType.MESSAGE_ACKED)
                                    .messageId(originalId)
                                    .streamName(params.getStreamName())
                                    .details("Message routed to DLQ (max deliveries reached)")
                                    .build());

                                // NOTE: No MESSAGE_PRODUCED broadcast for DLQ here
                                // RedisStreamListenerService will automatically detect the new message
                                // in the DLQ stream and broadcast it via WebSocket
                            }
                        }
                    }
                }
            }

            log.info("claim_or_dlq completed: {} messages to process, {} sent to DLQ",
                messagesToProcess, messagesSentToDLQ);

            // NOTE: element[0] is "messages to process" (new + reclaimed), not purely reclaimed.
            // messagesReclaimed/reclaimedMessageIds carry that count; messagesToDLQ carries the
            // dlq_ids count from element[1].
            return DLQResponse.builder()
                .success(true)
                .messagesReclaimed(messagesToProcess)
                .messagesToDLQ(messagesSentToDLQ)
                .reclaimedMessageIds(messageIdsToProcess)
                .details("Processed " + messagesToProcess + " messages, " + messagesSentToDLQ + " sent to DLQ")
                .build();

        } catch (Exception e) {
            log.error("Failed to execute claim_or_dlq", e);

            webSocketEventService.broadcastEvent(DLQEvent.builder()
                .eventType(DLQEvent.EventType.ERROR)
                .streamName(params.getStreamName())
                .details("Error executing claim_or_dlq: " + e.getMessage())
                .build());

            return DLQResponse.builder()
                .success(false)
                .errorMessage(e.getMessage())
                .build();
        }
    }

    /**
     * Consumes new messages from the stream using XREADGROUP.
     *
     * This method reads new messages (using '>') that haven't been delivered yet.
     * Messages are automatically added to the pending entries list (PEL).
     *
     * @param params DLQ parameters
     * @param count Number of messages to read
     * @return List of consumed message IDs
     */
    public List<String> consumeMessages(DLQParameters params, int count) {
        log.debug("Consuming {} messages from stream '{}'", count, params.getStreamName());

        List<String> messageIds = new ArrayList<>();

        try (var jedis = jedisPool.getResource()) {
            // Read new messages using '>' special ID
            Map<String, StreamEntryID> streams = new HashMap<>();
            streams.put(params.getStreamName(), StreamEntryID.XREADGROUP_UNDELIVERED_ENTRY);

            var entries = jedis.xreadGroup(
                params.getConsumerGroup(),
                params.getConsumerName(),
                XReadGroupParams.xReadGroupParams()
                    .count(count)
                    // Finite block (2s): block(0) would block the borrowed pooled
                    // connection FOREVER when no undelivered entries exist, leaking it
                    // and hanging the REST thread. A finite timeout guarantees the
                    // connection is returned to the pool. A null/empty return is fine
                    // (handled by the 'if (entries != null)' check below).
                    .block(2000),
                streams
            );

            if (entries != null) {
                for (var streamEntries : entries) {
                    for (StreamEntry entry : streamEntries.getValue()) {
                        String messageId = entry.getID().toString();
                        messageIds.add(messageId);

                        // Broadcast consumption event
                        webSocketEventService.broadcastEvent(DLQEvent.builder()
                            .eventType(DLQEvent.EventType.INFO)
                            .messageId(messageId)
                            .payload(entry.getFields())
                            .consumer(params.getConsumerName())
                            .streamName(params.getStreamName())
                            .details("Message consumed (pending)")
                            .build());
                    }
                }
            }

            log.debug("Consumed {} messages", messageIds.size());
            return messageIds;

        } catch (Exception e) {
            log.error("Failed to consume messages", e);
            throw new RuntimeException("Failed to consume messages", e);
        }
    }

    /**
     * Get pending messages for a consumer group.
     * Returns messages that have been delivered but not yet acknowledged.
     *
     * @param streamName Name of the stream
     * @param groupName Consumer group name
     * @param count Maximum number of pending messages to return
     * @return List of pending messages with their IDs and fields
     */
    public List<Map<String, Object>> getPendingMessages(String streamName, String groupName, int count) {
        log.debug("Getting {} pending messages for stream '{}', group '{}'", count, streamName, groupName);

        List<Map<String, Object>> messages = new ArrayList<>();

        try (var jedis = jedisPool.getResource()) {
            // Get pending message IDs
            var pendingInfo = jedis.xpending(
                streamName,
                groupName,
                redis.clients.jedis.params.XPendingParams.xPendingParams(
                    StreamEntryID.MINIMUM_ID,
                    StreamEntryID.MAXIMUM_ID,
                    count
                )
            );

            if (pendingInfo != null && !pendingInfo.isEmpty()) {
                // For each pending message ID, fetch the actual message content
                for (var info : pendingInfo) {
                    StreamEntryID messageId = info.getID();

                    // Use XRANGE to get the message content
                    List<StreamEntry> entries = jedis.xrange(streamName, messageId, messageId, 1);

                    if (entries != null && !entries.isEmpty()) {
                        StreamEntry entry = entries.get(0);
                        Map<String, Object> message = new HashMap<>();
                        message.put("id", entry.getID().toString());
                        message.put("fields", entry.getFields());
                        message.put("deliveryCount", info.getDeliveredTimes());
                        // XNACK-released entries (Redis 8.8+) have no owner and idle = -1
                        message.put("consumer", info.getConsumerName() == null ? "" : info.getConsumerName());
                        message.put("idleMs", info.getIdleTime());
                        messages.add(message);
                    }
                }
            }

            log.debug("Found {} pending messages", messages.size());
            return messages;

        } catch (redis.clients.jedis.exceptions.JedisDataException e) {
            if (e.getMessage() != null && e.getMessage().contains("NOGROUP")) {
                log.debug("Consumer group '{}' does not exist for stream '{}', returning empty list", groupName, streamName);
                return messages; // Return empty list if group doesn't exist (normal before first process)
            }
            log.error("Failed to get pending messages", e);
            throw new RuntimeException("Failed to get pending messages", e);
        } catch (Exception e) {
            log.error("Failed to get pending messages", e);
            throw new RuntimeException("Failed to get pending messages", e);
        }
    }

    /**
     * Get the next pending message ID (oldest pending message).
     * Returns null if no pending messages exist.
     *
     * @param streamName Name of the stream
     * @param groupName Consumer group name
     * @return Message ID of the next pending message, or null if none
     */
    public String getNextPendingMessageId(String streamName, String groupName) {
        log.debug("Getting next pending message for stream '{}', group '{}'", streamName, groupName);

        try (var jedis = jedisPool.getResource()) {
            // Get pending messages summary (oldest first, limit 1)
            var pendingInfo = jedis.xpending(
                streamName,
                groupName,
                redis.clients.jedis.params.XPendingParams.xPendingParams(
                    StreamEntryID.MINIMUM_ID,
                    StreamEntryID.MAXIMUM_ID,
                    1
                )
            );

            if (pendingInfo != null && !pendingInfo.isEmpty()) {
                String nextMessageId = pendingInfo.get(0).getID().toString();
                log.debug("Next pending message: {}", nextMessageId);
                return nextMessageId;
            }

            log.debug("No pending messages found");
            return null;

        } catch (redis.clients.jedis.exceptions.JedisDataException e) {
            if (e.getMessage() != null && e.getMessage().contains("NOGROUP")) {
                log.debug("Consumer group '{}' does not exist for stream '{}', returning null", groupName, streamName);
                return null; // Return null if group doesn't exist (normal before first process)
            }
            log.error("Failed to get next pending message", e);
            return null;
        } catch (Exception e) {
            log.error("Failed to get next pending message", e);
            return null;
        }
    }

    /**
     * Acknowledges a message, removing it from the pending entries list.
     *
     * This should be called after successful message processing.
     *
     * @param streamName Name of the stream
     * @param groupName Consumer group name
     * @param messageId Message ID to acknowledge
     * @return true if acknowledged successfully
     */
    public boolean acknowledgeMessage(String streamName, String groupName, String messageId) {
        log.debug("Acknowledging message {} in stream '{}'", messageId, streamName);

        try (var jedis = jedisPool.getResource()) {
            long acked = jedis.xack(streamName, groupName, new StreamEntryID(messageId));

            if (acked > 0) {
                // Note: We don't emit MESSAGE_DELETED here because the stream is a log
                // Messages stay visible in the UI even after ACK (only DLQ routing removes them from UI)
                log.debug("Message {} acknowledged successfully", messageId);
                return true;
            }

            return false;

        } catch (Exception e) {
            log.error("Failed to acknowledge message {}", messageId, e);
            return false;
        }
    }

    /**
     * Unified method to get the next batch of messages to process.
     *
     * This method uses Redis 8.4.0+ XREADGROUP CLAIM option to:
     * 1. Claim idle pending messages (deliveryCount < maxDeliveries)
     * 2. Route messages to DLQ (deliveryCount >= maxDeliveries)
     * 3. Read new incoming messages
     *
     * All in a single Lua script call, replacing the previous two-step process.
     *
     * Usage example:
     * <pre>
     * List&lt;DLQMessage&gt; messages = dlqService.getNextMessages(params, 10);
     *
     * for (DLQMessage msg : messages) {
     *     try {
     *         processMessage(msg);
     *         dlqService.acknowledgeMessage(msg.getStreamName(), msg.getConsumerGroup(), msg.getId());
     *     } catch (Exception e) {
     *         // Message will be automatically retried
     *         log.error("Failed to process message", e);
     *     }
     * }
     * </pre>
     *
     * @param params DLQ parameters
     * @param count Maximum number of messages to retrieve
     * @return List of messages ready for processing (claimed pending + new messages)
     */
    public List<DLQMessage> getNextMessages(DLQParameters params, int count) {
        log.debug("Getting next {} messages from stream '{}' using process_and_read", count, params.getStreamName());

        List<DLQMessage> result = new ArrayList<>();

        try (var jedis = jedisPool.getResource()) {
            // Call the new Lua function that uses XREADGROUP CLAIM
            // KEYS: [stream, dlq_stream]
            // ARGS: [group, consumer, minIdle, count, maxDeliveries]
            Object luaResult = jedis.fcall(
                FUNCTION_NAME,
                Arrays.asList(params.getStreamName(), params.getDlqStreamName()),
                Arrays.asList(
                    params.getConsumerGroup(),
                    params.getConsumerName(),
                    String.valueOf(params.getMinIdleMs()),
                    String.valueOf(count),
                    String.valueOf(params.getMaxDeliveries())
                )
            );

            // Parse the Lua result: { messages: [...], dlq_ids: [...] }
            if (luaResult instanceof List) {
                @SuppressWarnings("unchecked")
                List<Object> resultList = (List<Object>) luaResult;

                if (resultList.size() >= 2) {
                    // Parse messages to process
                    @SuppressWarnings("unchecked")
                    List<Object> messages = (List<Object>) resultList.get(0);

                    // Parse DLQ messages
                    @SuppressWarnings("unchecked")
                    List<Object> dlqMessages = (List<Object>) resultList.get(1);

                    // Process DLQ messages (broadcast events)
                    for (Object dlqItem : dlqMessages) {
                        if (dlqItem instanceof List) {
                            @SuppressWarnings("unchecked")
                            List<Object> dlqEntry = (List<Object>) dlqItem;
                            if (dlqEntry.size() >= 2) {
                                String originalId = convertToString(dlqEntry.get(0));
                                String dlqId = convertToString(dlqEntry.get(1));

                                log.info("Message {} routed to DLQ with ID {}", originalId, dlqId);

                                // Broadcast DLQ event
                                webSocketEventService.broadcastEvent(DLQEvent.builder()
                                    .eventType(DLQEvent.EventType.MESSAGE_TO_DLQ)
                                    .messageId(originalId)
                                    .streamName(params.getStreamName())
                                    .details(String.format("Max deliveries reached, moved to DLQ (%s) with ID %s",
                                        params.getDlqStreamName(), dlqId))
                                    .build());
                            }
                        }
                    }

                    // Process messages ready for processing
                    for (Object msgItem : messages) {
                        if (msgItem instanceof List) {
                            @SuppressWarnings("unchecked")
                            List<Object> msgEntry = (List<Object>) msgItem;
                            if (msgEntry.size() >= 2) {
                                String messageId = convertToString(msgEntry.get(0));

                                @SuppressWarnings("unchecked")
                                List<Object> fieldsList = (List<Object>) msgEntry.get(1);

                                Map<String, String> fields = new HashMap<>();
                                for (int i = 0; i < fieldsList.size(); i += 2) {
                                    String key = convertToString(fieldsList.get(i));
                                    String value = convertToString(fieldsList.get(i + 1));
                                    fields.put(key, value);
                                }

                                // Get delivery count from XPENDING
                                int deliveryCount = getDeliveryCount(
                                    jedis,
                                    params.getStreamName(),
                                    params.getConsumerGroup(),
                                    messageId
                                );

                                boolean isRetry = deliveryCount > 1;

                                DLQMessage dlqMessage = DLQMessage.builder()
                                    .id(messageId)
                                    .fields(fields)
                                    .deliveryCount(deliveryCount)
                                    .retry(isRetry)
                                    .streamName(params.getStreamName())
                                    .consumerGroup(params.getConsumerGroup())
                                    .consumerName(params.getConsumerName())
                                    .build();

                                result.add(dlqMessage);

                                log.debug("Added {} message: {}", isRetry ? "retry" : "new", dlqMessage.getSummary());

                                // Broadcast consumption event
                                webSocketEventService.broadcastEvent(DLQEvent.builder()
                                    .eventType(isRetry ? DLQEvent.EventType.MESSAGE_RECLAIMED : DLQEvent.EventType.INFO)
                                    .messageId(messageId)
                                    .payload(fields)
                                    .consumer(params.getConsumerName())
                                    .streamName(params.getStreamName())
                                    .details(isRetry ? "Message reclaimed for retry" : "Message consumed (pending)")
                                    .build());
                            }
                        }
                    }
                }
            }

            log.info("Returning {} messages ({} retries, {} new) from process_and_read",
                result.size(),
                (int) result.stream().filter(DLQMessage::isRetry).count(),
                (int) result.stream().filter(m -> !m.isRetry()).count()
            );

            return result;

        } catch (Exception e) {
            log.error("Failed to get next messages using process_and_read", e);
            throw new RuntimeException("Failed to get next messages", e);
        }
    }

    /**
     * Helper method to get the delivery count for a specific message.
     *
     * @param jedis Jedis connection
     * @param streamName Stream name
     * @param groupName Consumer group name
     * @param messageId Message ID
     * @return Delivery count, or 1 if XPENDING has no entry (treat as a new/first delivery)
     */
    private int getDeliveryCount(redis.clients.jedis.Jedis jedis, String streamName, String groupName, String messageId) {
        try {
            // Use XPENDING with range to get details for this specific message
            var pending = jedis.xpending(
                streamName,
                groupName,
                redis.clients.jedis.params.XPendingParams.xPendingParams(
                    new StreamEntryID(messageId),
                    new StreamEntryID(messageId),
                    1
                )
            );

            if (pending != null && !pending.isEmpty()) {
                return (int) pending.get(0).getDeliveredTimes();
            }
        } catch (Exception e) {
            log.warn("Failed to get delivery count for message {}", messageId, e);
        }
        // An XPENDING miss means we could not confirm a redelivery, so treat the
        // message as a first/new delivery (count 1) rather than misclassifying it as a retry.
        return 1;
    }

    /**
     * Gets the count of pending messages in the stream.
     *
     * @param streamName Stream name
     * @param groupName Consumer group name
     * @return Number of pending messages
     */
    /** True when Redis rejected the command because the stream or the group does not exist yet. */
    private static boolean isNoGroup(Exception e) {
        String message = e.getMessage();
        return message != null && message.contains("NOGROUP");
    }

    public long getPendingCount(String streamName, String groupName) {
        try (var jedis = jedisPool.getResource()) {
            var pendingInfo = jedis.xpending(streamName, groupName);
            return pendingInfo != null ? pendingInfo.getTotal() : 0;
        } catch (Exception e) {
            // A group that does not exist yet is the normal state of a freshly flushed Redis whose
            // DLQ page nobody has opened. There are zero pending messages, which is the honest
            // answer — logging it at ERROR made a clean startup look broken.
            if (isNoGroup(e)) {
                log.debug("No consumer group '{}' on stream '{}' yet — 0 pending", groupName, streamName);
                return 0;
            }
            log.error("Failed to get pending count", e);
            return 0;
        }
    }

    /**
     * Gets the length of a stream.
     *
     * @param streamName Stream name
     * @return Number of messages in the stream
     */
    public long getStreamLength(String streamName) {
        try (var jedis = jedisPool.getResource()) {
            return jedis.xlen(streamName);
        } catch (Exception e) {
            log.error("Failed to get stream length", e);
            return 0;
        }
    }

    /**
     * Reads the most recent messages from a stream.
     *
     * This method reads messages in reverse chronological order (newest first).
     * It uses XREVRANGE to get the last N messages from the stream.
     *
     * @param streamName Stream name to read from
     * @param count Maximum number of messages to read
     * @return List of messages with their IDs and fields
     */
    public List<Map<String, Object>> readMessages(String streamName, int count) {
        log.debug("Reading {} messages from stream '{}'", count, streamName);

        List<Map<String, Object>> messages = new ArrayList<>();

        try (var jedis = jedisPool.getResource()) {
            // Use XREVRANGE to get the last N messages (newest first)
            // XREVRANGE key + - COUNT count
            List<StreamEntry> entries = jedis.xrevrange(streamName, (StreamEntryID) null, (StreamEntryID) null, count);

            if (entries != null && !entries.isEmpty()) {
                for (StreamEntry entry : entries) {
                    Map<String, Object> message = new HashMap<>();
                    message.put("id", entry.getID().toString());
                    message.put("fields", entry.getFields());
                    messages.add(message);
                }
            }

            log.debug("Read {} messages from stream '{}'", messages.size(), streamName);
            return messages;

        } catch (Exception e) {
            log.error("Failed to read messages from stream '{}'", streamName, e);
            throw new RuntimeException("Failed to read messages", e);
        }
    }

    /**
     * Processes the next available message with success or failure simulation.
     *
     * This method:
     * 1. Ensures consumer groups are initialized
     * 2. Gets the next message using getNextMessages()
     * 3. If shouldSucceed is true: acknowledges the message (success)
     * 4. If shouldSucceed is false: does NOT acknowledge (will retry)
     *
     * @param shouldSucceed Whether to simulate success (true) or failure (false)
     * @return Map containing success status and message details
     */
    public Map<String, Object> processNextMessage(boolean shouldSucceed) {
        return processNextMessage(ProcessOutcome.fromLegacy(shouldSucceed));
    }

    /**
     * Processes the next message and applies the given outcome.
     *
     * <p>ACK acknowledges (success), NO_ACK leaves the message owned (implicit failure, retried
     * after {@code minIdleMs}). The NACK_* outcomes use the Redis 8.8+ {@code XNACK} command:
     * the message is released immediately (no {@code minIdleMs} wait) and the delivery counter
     * is kept (FAIL), forced to {@code Long.MAX_VALUE} (FATAL — swept to the DLQ by the next
     * poll) or reset to 0 (SILENT — the failure budget is refunded).
     *
     * @param outcome What to do with the message after reading it
     * @return Map containing success status and message details
     */
    public Map<String, Object> processNextMessage(ProcessOutcome outcome) {
        log.info("Processing next message with outcome={}", outcome);

        Map<String, Object> response = new HashMap<>();
        response.put("outcome", outcome.name());

        try {
            // Get default configuration
            DLQConfigRequest config = dlqConfigService.getConfiguration("test-stream");

            // Build parameters
            DLQParameters params = DLQParameters.builder()
                .streamName(config.getStreamName())
                .dlqStreamName(config.getDlqStreamName())
                .consumerGroup(config.getConsumerGroup())
                .consumerName(config.getConsumerName())
                .minIdleMs(config.getMinIdleMs())
                .count(config.getCount())
                .maxDeliveries(config.getMaxDeliveries())
                .build();

            // Initialize consumer groups if they don't exist
            log.debug("Ensuring consumer groups are initialized");
            initializeConsumerGroup(params.getStreamName(), params.getConsumerGroup());
            initializeConsumerGroup(params.getDlqStreamName(), params.getConsumerGroup() + "-dlq");

            // Get next message (retries first, then new messages)
            List<DLQMessage> messages = getNextMessages(params, 1);

            if (messages.isEmpty()) {
                response.put("success", false);
                response.put("message", "No messages available to process");
                return response;
            }

            DLQMessage message = messages.get(0);
            log.info("Processing message: {}", message.getSummary());

            if (outcome == ProcessOutcome.ACK) {
                // Broadcast MESSAGE_PROCESSED event for visual feedback (flash effect) BEFORE deleting
                webSocketEventService.broadcastEvent(DLQEvent.builder()
                    .eventType(DLQEvent.EventType.MESSAGE_PROCESSED)
                    .messageId(message.getId())
                    .payload(message.getFields())
                    .deliveryCount((long) message.getDeliveryCount())
                    .consumer(params.getConsumerName())
                    .streamName(params.getStreamName())
                    .details("Processing succeeded")
                    .build());

                // Small delay to allow flash animation to be visible before message disappears
                try {
                    Thread.sleep(100);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }

                // Simulate successful processing - acknowledge the message
                boolean acked = acknowledgeMessage(
                    message.getStreamName(),
                    message.getConsumerGroup(),
                    message.getId()
                );

                if (acked) {
                    response.put("success", true);
                    response.put("message", String.format("✓ Message %s processed successfully (deliveryCount: %d)",
                        message.getId(), message.getDeliveryCount()));
                    response.put("messageId", message.getId());
                    response.put("deliveryCount", message.getDeliveryCount());
                    response.put("wasRetry", message.isRetry());
                } else {
                    response.put("success", false);
                    response.put("message", "Failed to acknowledge message");
                }
            } else if (outcome == ProcessOutcome.NO_ACK) {
                // Simulate failed processing - do NOT acknowledge (message will retry)
                response.put("success", true);
                response.put("message", String.format("✗ Message %s processing failed (will retry, deliveryCount: %d)",
                    message.getId(), message.getDeliveryCount()));
                response.put("messageId", message.getId());
                response.put("deliveryCount", message.getDeliveryCount());
                response.put("wasRetry", message.isRetry());

                // Broadcast MESSAGE_RECLAIMED event for visual feedback (flash effect)
                webSocketEventService.broadcastEvent(DLQEvent.builder()
                    .eventType(DLQEvent.EventType.MESSAGE_RECLAIMED)
                    .messageId(message.getId())
                    .payload(message.getFields())
                    .deliveryCount((long) message.getDeliveryCount())
                    .consumer(params.getConsumerName())
                    .streamName(params.getStreamName())
                    .details("Processing failed - will retry")
                    .build());

                log.info("Message {} not acknowledged - will be retried", message.getId());
            } else {
                // Explicit release via XNACK (Redis 8.8+): immediate, no minIdle wait
                XNackMode mode = outcome.xnackMode();
                long released = xnack(params.getStreamName(), params.getConsumerGroup(), mode, message.getId());

                if (released == 0) {
                    // Raced: the message was ACKed/claimed away between read and XNACK
                    response.put("success", false);
                    response.put("message", String.format(
                        "Message %s was no longer pending — nothing released", message.getId()));
                    response.put("messageId", message.getId());
                    return response;
                }

                long counterAfter = switch (outcome) {
                    case NACK_SILENT -> 0L;
                    case NACK_FATAL -> Long.MAX_VALUE;
                    default -> (long) message.getDeliveryCount();
                };
                String statusMessage = switch (outcome) {
                    case NACK_FAIL -> String.format(
                        "✗ Message %s explicitly NACKed (FAIL) — immediately retryable (deliveryCount: %d)",
                        message.getId(), counterAfter);
                    case NACK_FATAL -> String.format(
                        "☠ Message %s poisoned (FATAL) — will be swept to DLQ on next poll", message.getId());
                    default -> String.format(
                        "↩ Message %s released (SILENT) — failure budget refunded (deliveryCount: 0)",
                        message.getId());
                };

                response.put("success", true);
                response.put("message", statusMessage);
                response.put("messageId", message.getId());
                response.put("deliveryCount", counterAfter);
                response.put("wasRetry", message.isRetry());

                webSocketEventService.broadcastEvent(DLQEvent.builder()
                    .eventType(DLQEvent.EventType.MESSAGE_NACKED)
                    .messageId(message.getId())
                    .payload(message.getFields())
                    .deliveryCount(counterAfter)
                    .consumer(params.getConsumerName())
                    .streamName(params.getStreamName())
                    .details("XNACK " + mode)
                    .build());

                log.info("Message {} XNACKed with mode {}", message.getId(), mode);
            }

            return response;

        } catch (Exception e) {
            log.error("Error processing next message", e);
            response.put("success", false);
            response.put("message", "Error: " + e.getMessage());
            return response;
        }
    }

    /**
     * Releases a pending message back to the group's PEL via XNACK (Redis 8.8+).
     *
     * <p>Typed since Jedis 8.0.0; before that this went through a raw {@code sendCommand}.
     * Jedis still has no typed {@code RETRYCOUNT}/{@code FORCE}, which this demo does not use.
     * Package-private for tests.
     *
     * @param mode {@link XNackMode#FAIL}, {@link XNackMode#FATAL} or {@link XNackMode#SILENT}
     * @return number of messages actually released (0 if the id was not pending)
     */
    long xnack(String streamName, String groupName, XNackMode mode, String messageId) {
        try (var jedis = jedisPool.getResource()) {
            return jedis.xnack(streamName, groupName, mode, new StreamEntryID(messageId));
        }
    }

    /**
     * Cleans up streams and consumer groups for testing.
     *
     * WARNING: This deletes all data in the specified streams.
     *
     * @param streamName Main stream name
     * @param dlqStreamName DLQ stream name
     */
    public void cleanup(String streamName, String dlqStreamName) {
        log.info("Cleaning up streams: {}, {}", streamName, dlqStreamName);

        try (var jedis = jedisPool.getResource()) {
            jedis.del(streamName, dlqStreamName);

            webSocketEventService.broadcastEvent(DLQEvent.builder()
                .eventType(DLQEvent.EventType.INFO)
                .streamName(streamName)
                .details("Streams cleaned up")
                .build());

            log.info("Cleanup completed");
        } catch (Exception e) {
            log.error("Failed to cleanup streams", e);
        }
    }



    /**
     * Clears the default DLQ demo streams (test-stream and test-stream:dlq).
     * Called at startup to ensure a clean state for demos.
     */
    public void clearDLQStreams() {
        log.info("Clearing DLQ demo streams...");
        deleteStream("test-stream");
        deleteStream("test-stream:dlq");
        log.info("DLQ demo streams cleared");
    }

    /**
     * Deletes a stream if it exists.
     *
     * @param streamName Name of the stream to delete
     * @return true if the stream was deleted, false if it didn't exist
     */
    public boolean deleteStream(String streamName) {
        log.info("Deleting stream: {}", streamName);

        try (var jedis = jedisPool.getResource()) {
            // Check if stream exists
            if (!jedis.exists(streamName)) {
                log.info("Stream '{}' does not exist", streamName);
                return false;
            }

            // Delete the stream
            jedis.del(streamName);
            log.info("Stream '{}' deleted successfully", streamName);

            // Broadcast event
            webSocketEventService.broadcastEvent(DLQEvent.builder()
                .eventType(DLQEvent.EventType.INFO)
                .streamName(streamName)
                .details("Stream deleted")
                .build());

            return true;

        } catch (Exception e) {
            log.error("Failed to delete stream '{}'", streamName, e);
            throw new RuntimeException("Failed to delete stream", e);
        }
    }

    /**
     * Helper method to convert Redis response objects to String.
     * Handles both byte[] (from native Redis commands) and String (from Lua FCALL).
     *
     * @param obj The object to convert (byte[] or String)
     * @return The string representation
     */
    private String convertToString(Object obj) {
        if (obj instanceof byte[]) {
            return new String((byte[]) obj);
        } else if (obj instanceof String) {
            return (String) obj;
        } else {
            throw new IllegalArgumentException("Unexpected type: " + obj.getClass().getName());
        }
    }
}

