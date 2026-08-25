#!lua name=stream_utils

--[[
  ============================================================================
  Redis Streams Utility Functions Library
  ============================================================================

  This library contains multiple functions for Redis Streams patterns:
  1. read_claim_or_dlq - DLQ pattern with XREADGROUP CLAIM (Redis 8.4.0+)
  2. request - Request/Reply pattern request sender
  3. response - Request/Reply pattern response sender
  4. route_message - Topic routing pattern (routes messages based on routing key)
  5. acquire_token - Token Bucket: atomic check-and-increment of a concurrency counter
  6. release_token - Token Bucket: decrement the concurrency counter, floored at 0
  7. release_lock - Per-Key Serialized: compare-and-delete a lock (owner-checked)

  Author: Redis Patterns Team
  Redis Version: 8.8.0+ (demo baseline, for XNACK; read_claim_or_dlq itself needs 8.4.0+)
]]

-- ============================================================================
-- Function 1: read_claim_or_dlq (DLQ Pattern)
-- ============================================================================
--
-- This function implements the Dead Letter Queue (DLQ) pattern using Redis 8.4.0+
-- XREADGROUP CLAIM option to atomically claim and read messages.
--
-- The function performs the following steps:
-- 1. Check pending messages (XPENDING) and identify messages that reached max delivery count (deliveries >= maxDeliver)
-- 2. Route messages to DLQ (XCLAIM + XADD + XACK)
-- 3. Use XREADGROUP with CLAIM to get pending + new messages in a single atomic operation
-- 4. Return messages to process and DLQ message IDs
--
-- KEYS:
--   [1] stream - The main stream name (e.g., "test-stream")
--   [2] dlq - The DLQ stream name (e.g., "test-stream:dlq")
--
-- ARGS:
--   [1] group - Consumer group name
--   [2] consumer - Consumer name
--   [3] minIdle - Minimum idle time in milliseconds for claiming messages
--   [4] count - Maximum number of messages to read
--   [5] maxDeliver - Maximum delivery count before routing to DLQ
--
-- RETURNS:
--   A table with two elements:
--   [1] messages_to_process - Array of [id, fields] for messages to process
--   [2] dlq_ids - Array of [original_id, dlq_id] for messages routed to DLQ
--
-- TIMING NOTE (verified empirically against Redis 8.4 and 8.8):
--   The DLQ check (step 1) runs BEFORE the re-read (step 3), so it only sees
--   delivery counts from PREVIOUS calls. A poison message is therefore
--   delivered maxDeliver times, then swept to the DLQ by the NEXT call:
--   maxDeliver+1 FCALLs in total, each spaced by at least minIdle ms.
--   The XREADGROUP ... CLAIM re-delivery DOES increment the delivery counter.
--
-- DLQ ENTRY METADATA (added 2026-08-25):
--   Each swept entry carries two extra fields beyond the original payload:
--     reason     - 'max deliveries (N) reached', or 'poison (XNACK FATAL): ...' when the counter
--                  was forced past 2^53 by an explicit FATAL nack
--     originalId - the id the entry had in the source stream
--     failedVia  - ordered, comma-separated failure actions that got it there (e.g.
--                  'NO_ACK,NACK_FAIL'), present only when the caller passes ARGV[6]
--   Same field names as the LLM Chat sweeper (LlmRecoverySweeper#routeToDlq), so both DLQs read
--   alike. Consumers that only assert on original payload fields are unaffected.
--
-- CHANGE WITH CARE - the blog post `blog/dlq-redis-streams` quotes this function; it is published
-- against the pinned tag blog-dlq-v1, so readers are unaffected until the post is re-tagged.
-- ============================================================================

-- A delivery counter at or above 2^53 means XNACK FATAL forced it to Long.MAX_VALUE. The threshold
-- (rather than an equality test) is deliberate: the same value loses precision once it crosses JSON
-- into JavaScript, so the UI compares the same way.
local POISON_DELIVERIES = 9007199254740992

-- Helper function to copy fields from one stream entry to another, optionally appending extra
-- field/value pairs (used to record WHY an entry landed in the DLQ).
local function xadd_copy_fields(stream, fields, extra)
  local args = {}
  for i = 1, #fields, 2 do
    args[#args + 1] = fields[i]
    args[#args + 1] = fields[i + 1]
  end
  if extra then
    for i = 1, #extra do
      args[#args + 1] = extra[i]
    end
  end
  return redis.call('XADD', stream, '*', unpack(args))
end

redis.register_function('read_claim_or_dlq', function(keys, args)
  -- Parse input parameters
  local stream      = keys[1]  -- Main stream name
  local dlq         = keys[2]  -- DLQ stream name
  local group       = args[1]  -- Consumer group name
  local consumer    = args[2]  -- Consumer name
  local minIdle     = tonumber(args[3])  -- Min idle time in ms
  local count       = tonumber(args[4])  -- Max messages to read
  local maxDeliver  = tonumber(args[5])  -- Max delivery count

  -- ARGV[6] (OPTIONAL): JSON object mapping message id -> the ordered failure actions that got it
  -- there, e.g. {"1787-0":"NO_ACK,NO_ACK"}. Deliberately the LAST argument and optional: five other
  -- services and the blog post's six language samples call this function with exactly five args, and
  -- they must keep working untouched. pcall'd because a malformed argument must degrade to "unknown
  -- scenario", never break the sweep.
  local failed_via = {}
  if args[6] and args[6] ~= '' then
    local ok, decoded = pcall(cjson.decode, args[6])
    if ok and type(decoded) == 'table' then
      failed_via = decoded
    end
  end

  -- Initialize result arrays
  local messages_to_process = {}
  local dlq_ids = {}

  -- -------------------------------------------------------------------------
  -- Step 1: Check pending messages and route to DLQ if needed
  -- -------------------------------------------------------------------------
  -- XPENDING returns: [[id, consumer, idle, deliveries], ...]
  local pending = redis.call('XPENDING', stream, group, 'IDLE', minIdle, '-', '+', count)

  -- Collect IDs of messages that exceeded max delivery count
  local to_dlq_ids = {}
  local deliveries_by_id = {}
  for i = 1, #pending do
    local p = pending[i]  -- [id, consumer, idle, deliveries]
    local id = p[1]
    local deliveries = tonumber(p[4])

    -- If message reached (>=) max delivery count, mark for DLQ
    if deliveries >= maxDeliver then
      to_dlq_ids[#to_dlq_ids + 1] = id
      -- Kept so the DLQ entry can say why it is there, not just that it is.
      deliveries_by_id[id] = deliveries
    end
  end

  -- -------------------------------------------------------------------------
  -- Step 2: Route messages to DLQ (claim, copy to DLQ, ACK)
  -- -------------------------------------------------------------------------
  if #to_dlq_ids > 0 then
    -- Claim the messages that need to go to DLQ
    local claimed_dlq = redis.call('XCLAIM', stream, group, consumer, minIdle, unpack(to_dlq_ids))

    -- For each claimed message, copy to DLQ and ACK from main stream
    for i = 1, #claimed_dlq do
      local item = claimed_dlq[i]
      if item and item[1] and item[2] then
        local eid    = item[1]  -- Original message ID
        local fields = item[2]  -- Message fields

        -- Copy message to DLQ stream, self-describing: a DLQ entry nobody can diagnose is
        -- useless. Field names match the LLM Chat sweeper's convention (reason / originalId).
        local deliveries = deliveries_by_id[eid] or 0
        local reason
        if deliveries >= POISON_DELIVERIES then
          reason = 'poison (XNACK FATAL): delivery counter forced to max'
        else
          reason = 'max deliveries (' .. deliveries .. ') reached'
        end
        local extra = { 'reason', reason, 'originalId', eid }
        -- Which scenario put it here. The delivery counter says the budget ran out; only the caller
        -- knows *how* it ran out, so it has to be told to us.
        if failed_via[eid] then
          extra[#extra + 1] = 'failedVia'
          extra[#extra + 1] = failed_via[eid]
        end
        local new_dlq_id = xadd_copy_fields(dlq, fields, extra)

        -- ACK message from main stream (removes from PENDING list)
        redis.call('XACK', stream, group, eid)

        -- Track DLQ routing (original ID -> DLQ ID)
        dlq_ids[#dlq_ids + 1] = { eid, new_dlq_id }
      end
    end
  end

  -- -------------------------------------------------------------------------
  -- Step 3: Use XREADGROUP with CLAIM to get pending + new messages
  -- -------------------------------------------------------------------------
  -- Redis 8.4.0+ feature: XREADGROUP with CLAIM option
  -- This atomically claims idle pending messages AND reads new messages
  -- XREADGROUP GROUP <group> <consumer> COUNT <count> CLAIM <minIdle> STREAMS <stream> >
  local result = redis.call('XREADGROUP', 'GROUP', group, consumer,
                            'COUNT', count,
                            'CLAIM', minIdle,
                            'STREAMS', stream, '>')

  -- -------------------------------------------------------------------------
  -- Step 4: Parse results
  -- -------------------------------------------------------------------------
  -- XREADGROUP returns: [[stream_name, [[id, fields], ...]]]
  if result and #result > 0 then
    local stream_data = result[1]  -- [stream_name, entries]
    if stream_data and #stream_data > 1 then
      local entries = stream_data[2]  -- [[id, fields], ...]

      -- Collect all messages to process
      for i = 1, #entries do
        local entry = entries[i]
        if entry and entry[1] and entry[2] then
          messages_to_process[#messages_to_process + 1] = { entry[1], entry[2] }
        end
      end
    end
  end

  -- Return: [messages_to_process, dlq_ids]
  return { messages_to_process, dlq_ids }
end)

-- ============================================================================
-- Function 2: request (Request/Reply Pattern - Request Sender)
-- ============================================================================
--
-- This function implements the Request/Reply pattern request sender.
-- It sends a request to a stream and sets up timeout tracking.
--
-- The function performs the following steps:
-- 1. Create a timeout tracking key (expires after timeout seconds)
-- 2. Create a shadow timeout tracking key (expires 10 seconds after timeout)
-- 3. Add correlation ID and business ID to the payload
-- 4. Post the request to the stream
-- 5. Return the message ID
--
-- KEYS:
--   [1] timeout_key - Redis key for timeout tracking (e.g., "order.holdInventory.request.timeout.v1:$correlationId")
--   [2] shadow_key - Redis key for shadow timeout tracking
--                    (e.g., "order.holdInventory.request.timeout.shadow.v1:$correlationId")
--   [3] stream_name - The request stream name (e.g., "order.holdInventory.v1")
--
-- ARGS:
--   [1] correlation_id - UUID v4 correlation ID
--   [2] business_id - Business identifier (e.g., order ID)
--   [3] stream_response_name - The response stream name (e.g., "order.holdInventory.response.v1")
--   [4] timeout - Timeout in seconds (e.g., 60)
--   [5] payload_json - JSON payload (e.g., {"orderId": "ORD-123", "items": [...]})
--
-- RETURNS:
--   The message ID of the request posted to the stream
--
-- TIMEOUT MECHANISM:
--   - timeout_key: Expires after timeout seconds, triggers Redis key expiration event
--   - shadow_key: Contains metadata for timeout handling (businessId, streamResponseName)
--   - If timeout_key expires, the timeout handler reads shadow_key and sends a TIMEOUT response
--
-- ============================================================================

redis.register_function('request', function(keys, args)
  -- Parse input parameters
  local timeout_key = keys[1]  -- Timeout tracking key
  local shadow_key = keys[2]   -- Shadow timeout tracking key
  local stream_name = keys[3]  -- Request stream name

  local correlation_id = args[1]        -- UUID v4 correlation ID
  local business_id = args[2]           -- Business identifier (e.g., order ID)
  local stream_response_name = args[3]  -- Response stream name
  local timeout = tonumber(args[4])     -- Timeout in seconds
  local payload_json = args[5]          -- JSON payload

  -- -------------------------------------------------------------------------
  -- Step 1: Create timeout tracking key
  -- -------------------------------------------------------------------------
  -- This key expires after timeout seconds and triggers a Redis key expiration event
  redis.call('SET', timeout_key, business_id, 'EX', timeout)

  -- -------------------------------------------------------------------------
  -- Step 2: Create shadow timeout tracking key
  -- -------------------------------------------------------------------------
  -- This key contains metadata for timeout handling
  -- It expires 10 seconds after the timeout to allow for processing
  redis.call('HSET', shadow_key,
    'businessId', business_id,
    'streamResponseName', stream_response_name
  )
  redis.call('EXPIRE', shadow_key, timeout + 10)

  -- -------------------------------------------------------------------------
  -- Step 3: Parse payload and add correlation_id and business_id
  -- -------------------------------------------------------------------------
  local payload = cjson.decode(payload_json)
  payload['correlationId'] = correlation_id
  payload['businessId'] = business_id

  -- -------------------------------------------------------------------------
  -- Step 4: Convert payload to flat key-value pairs for XADD
  -- -------------------------------------------------------------------------
  -- Redis Streams require flat key-value pairs
  -- Nested tables are JSON-encoded
  local xadd_args = {}
  for k, v in pairs(payload) do
    if type(v) == 'table' then
      table.insert(xadd_args, k)
      table.insert(xadd_args, cjson.encode(v))
    else
      table.insert(xadd_args, k)
      table.insert(xadd_args, tostring(v))
    end
  end

  -- -------------------------------------------------------------------------
  -- Step 5: Post request to stream
  -- -------------------------------------------------------------------------
  local message_id = redis.call('XADD', stream_name, '*', unpack(xadd_args))

  return message_id
end)

-- ============================================================================
-- Function 3: response (Request/Reply Pattern - Response Sender)
-- ============================================================================
--
-- This function implements the Request/Reply pattern response sender.
-- It sends a response to a stream and deletes the timeout tracking key.
--
-- The function performs the following steps:
-- 1. Delete the timeout tracking key (prevents timeout events)
-- 2. Add correlation ID and business ID to the payload
-- 3. Post the response to the stream
-- 4. Return the message ID
--
-- KEYS:
--   [1] timeout_key - Redis key for timeout tracking (e.g., "order.holdInventory.request.timeout.v1:$correlationId")
--   [2] stream_name - The response stream name (e.g., "order.holdInventory.response.v1")
--
-- ARGS:
--   [1] correlation_id - UUID v4 correlation ID (matches the request)
--   [2] business_id - Business identifier (e.g., order ID)
--   [3] payload_json - JSON payload (e.g., {"responseType": "OK", "items": [...]})
--
-- RETURNS:
--   The message ID of the response posted to the stream
--
-- TIMEOUT PREVENTION:
--   - Deleting timeout_key prevents the Redis key expiration event from firing
--   - This ensures that a TIMEOUT response is not sent if a real response is sent
--
-- ============================================================================

redis.register_function('response', function(keys, args)
  -- Parse input parameters
  local timeout_key = keys[1]     -- Timeout tracking key
  local stream_name = keys[2]     -- Response stream name

  local correlation_id = args[1]  -- UUID v4 correlation ID
  local business_id = args[2]     -- Business identifier (e.g., order ID)
  local payload_json = args[3]    -- JSON payload

  -- -------------------------------------------------------------------------
  -- Step 1: Delete the timeout tracking key (prevents timeout events)
  -- -------------------------------------------------------------------------
  -- If the timeout key is deleted, the Redis key expiration event will not fire
  -- This prevents a TIMEOUT response from being sent
  redis.call('DEL', timeout_key)

  -- -------------------------------------------------------------------------
  -- Step 2: Parse payload and add correlation_id and business_id
  -- -------------------------------------------------------------------------
  local payload = cjson.decode(payload_json)
  payload['correlationId'] = correlation_id
  payload['businessId'] = business_id

  -- -------------------------------------------------------------------------
  -- Step 3: Convert payload to flat key-value pairs for XADD
  -- -------------------------------------------------------------------------
  -- Redis Streams require flat key-value pairs
  -- Nested tables are JSON-encoded
  local xadd_args = {}
  for k, v in pairs(payload) do
    if type(v) == 'table' then
      table.insert(xadd_args, k)
      table.insert(xadd_args, cjson.encode(v))
    else
      table.insert(xadd_args, k)
      table.insert(xadd_args, tostring(v))
    end
  end

  -- -------------------------------------------------------------------------
  -- Step 4: Post response to stream
  -- -------------------------------------------------------------------------
  local message_id = redis.call('XADD', stream_name, '*', unpack(xadd_args))

  return message_id
end)


-- ============================================================================
-- Function 4: route_message (Topic Routing Pattern with Dynamic Rules)
-- ============================================================================
--
-- This function implements a dynamic Topic Routing pattern similar to RabbitMQ's
-- topic exchange, but MORE POWERFUL:
--   - Rules are stored in Redis and loaded dynamically (no redeploy needed)
--   - Uses Lua patterns (more expressive than RabbitMQ's * and #)
--   - Supports version-aware routing (v1 -> v1 targets, v2 -> v2 targets)
--   - Metadata configurable (maxRules, etc.)
--
-- Redis Data Structures:
--   routing:rules:{exchange_stream}   - Hash with rules (field=id, value=JSON)
--   routing:config:{exchange_stream}  - Hash with metadata (maxRules, version, etc.)
--
-- Rule JSON format:
--   {
--     "pattern": "^order%.",          -- Lua pattern to match routing key
--     "destination": "events.order.v1",   -- Target stream
--     "description": "All order events",
--     "priority": 10,                 -- Rule priority (lower = first)
--     "enabled": true,                -- Enable/disable rule
--     "stopOnMatch": false            -- If true, stop evaluating other rules after match
--   }
--
-- KEYS:
--   [1] exchange_stream - The main "exchange" stream (e.g., "events.topic.v1")
--
-- ARGS:
--   [1] routing_key - The routing key (e.g., "order.created.v1")
--   [2] payload_json - JSON payload to route
--
-- RETURNS:
--   {
--     exchange_id: ID in the exchange stream,
--     routed_to: array of {stream_name, message_id},
--     rules_evaluated: number of rules evaluated,
--     rules_matched: number of rules that matched
--   }
--
-- ============================================================================

redis.register_function('route_message', function(keys, args)
  local exchange_stream = keys[1]
  local routing_key = args[1]
  local payload_json = args[2]

  local routed_to = {}
  local rules_evaluated = 0
  local rules_matched = 0
  local rules_invalid = 0  -- rules whose pattern failed to compile (malformed Lua pattern)

  -- -------------------------------------------------------------------------
  -- Step 1: Load metadata/config from Redis
  -- -------------------------------------------------------------------------
  local config_key = 'routing:config:' .. exchange_stream
  local max_rules = tonumber(redis.call('HGET', config_key, 'maxRules')) or 20

  -- -------------------------------------------------------------------------
  -- Step 2: Extract version from exchange stream (e.g., 'events.topic.v1' -> '1')
  -- -------------------------------------------------------------------------
  local exchange_version = string.match(exchange_stream, '%.v(%d+)$')

  -- -------------------------------------------------------------------------
  -- Step 3: Parse payload and add routing metadata
  -- -------------------------------------------------------------------------
  local payload = cjson.decode(payload_json)
  payload['routingKey'] = routing_key
  payload['routedAt'] = redis.call('TIME')[1]
  if exchange_version then
    payload['apiVersion'] = 'v' .. exchange_version
  end

  local xadd_args = {}
  for k, v in pairs(payload) do
    if type(v) == 'table' then
      table.insert(xadd_args, k)
      table.insert(xadd_args, cjson.encode(v))
    else
      table.insert(xadd_args, k)
      table.insert(xadd_args, tostring(v))
    end
  end

  -- -------------------------------------------------------------------------
  -- Step 4: Add message to exchange stream (audit trail)
  -- -------------------------------------------------------------------------
  local exchange_id = redis.call('XADD', exchange_stream, '*', unpack(xadd_args))

  -- -------------------------------------------------------------------------
  -- Step 5: Load routing rules from Redis
  -- -------------------------------------------------------------------------
  local rules_key = 'routing:rules:' .. exchange_stream
  local rules_raw = redis.call('HGETALL', rules_key)

  local rules = {}
  for i = 1, #rules_raw, 2 do
    local rule_id = rules_raw[i]
    local rule_json = rules_raw[i + 1]
    local ok, rule = pcall(cjson.decode, rule_json)
    if ok and rule then
      rule.id = rule_id
      rule.priority = rule.priority or 100
      if rule.enabled == nil then rule.enabled = true end
      table.insert(rules, rule)
    end
  end

  -- Sort rules by priority (lower = higher priority)
  table.sort(rules, function(a, b) return a.priority < b.priority end)

  -- -------------------------------------------------------------------------
  -- Step 6: Evaluate rules and collect target streams
  -- -------------------------------------------------------------------------
  local target_streams = {}

  for _, rule in ipairs(rules) do
    if rules_evaluated >= max_rules then break end
    rules_evaluated = rules_evaluated + 1

    -- Check if rule should be evaluated
    local should_evaluate = rule.enabled and rule.pattern and rule.destination

    if should_evaluate then
      -- Evaluate Lua pattern.
      -- pcall guards against a malformed user-supplied pattern raising "malformed pattern":
      -- a bad rule is treated as "did not match" (skipped) instead of aborting the whole
      -- function, so one invalid rule no longer disables routing for the entire exchange.
      local ok, match = pcall(string.match, routing_key, rule.pattern)
      if not ok then
        rules_invalid = rules_invalid + 1
        match = nil
      end
      if match then
        local already_added = false
        for _, t in ipairs(target_streams) do
          if t == rule.destination then
            already_added = true
            break
          end
        end
        if not already_added then
          table.insert(target_streams, rule.destination)
          rules_matched = rules_matched + 1
        end
        -- If stopOnMatch is true, stop evaluating other rules
        if rule.stopOnMatch then
          break
        end
      end
    end
  end

  -- -------------------------------------------------------------------------
  -- Step 7: Route message to all matching target streams
  -- -------------------------------------------------------------------------
  for i = 1, #target_streams do
    local target = target_streams[i]
    local target_id = redis.call('XADD', target, '*', unpack(xadd_args))
    table.insert(routed_to, { target, target_id })
  end

  -- -------------------------------------------------------------------------
  -- Step 8: Return routing results with metadata
  -- -------------------------------------------------------------------------
  return { exchange_id, routed_to, rules_evaluated, rules_matched }
end)

-- ============================================================================
-- Function 5: acquire_token (Token Bucket Pattern)
-- ============================================================================
--
-- Atomically reserves a concurrency "token": reads the current running counter
-- and increments it only if it is still below the configured maximum. Running
-- the check-and-increment server-side guarantees no two workers can both pass
-- the cap on a race.
--
-- KEYS[1] = running counter key (e.g. token-bucket:running:csv)
-- ARGV[1] = max concurrency for this job type
-- Returns 1 if a token was acquired, 0 if the cap is already reached.
-- ============================================================================
redis.register_function('acquire_token', function(keys, args)
  local running_key = keys[1]
  local max_concurrency = tonumber(args[1])
  local current = tonumber(redis.call('GET', running_key) or '0')
  if current >= max_concurrency then
    return 0
  end
  redis.call('INCR', running_key)
  return 1
end)

-- ============================================================================
-- Function 6: release_token (Token Bucket Pattern)
-- ============================================================================
--
-- Releases a previously acquired token by decrementing the running counter,
-- floored at 0 so a stray release (or a double release after a redelivery)
-- can never drive the counter negative and silently raise the effective cap.
--
-- KEYS[1] = running counter key
-- Returns the counter value after release.
-- ============================================================================
redis.register_function('release_token', function(keys, _args)
  local running_key = keys[1]
  local current = tonumber(redis.call('GET', running_key) or '0')
  if current <= 0 then
    redis.call('SET', running_key, '0')
    return 0
  end
  return redis.call('DECR', running_key)
end)

-- ============================================================================
-- Function 7: release_lock (Per-Key Serialized Pattern)
-- ============================================================================
--
-- Compare-and-delete: releases a per-key lock only if it still holds OUR token.
-- A plain DEL could erase a lock that another worker re-acquired after our TTL
-- expired; checking the token server-side keeps the release owner-safe.
--
-- KEYS[1] = lock key (e.g. running:order:42)
-- ARGV[1] = token the caller stored when acquiring the lock (its message ID)
-- Returns 1 if the lock was released, 0 if it was not ours (or already gone).
-- ============================================================================
redis.register_function('release_lock', function(keys, args)
  local lock_key = keys[1]
  local token = args[1]
  if redis.call('GET', lock_key) == token then
    return redis.call('DEL', lock_key)
  end
  return 0
end)

