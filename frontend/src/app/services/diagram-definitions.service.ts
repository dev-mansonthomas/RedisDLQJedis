import { Injectable } from '@angular/core';

export interface DiagramDefinition {
  architecture: string;
  sequence: string;
}

@Injectable({
  providedIn: 'root'
})
export class DiagramDefinitionsService {

  // Worker nodes are labelled 1, 2, N (plus an ellipsis) rather than a fixed count: the pool is
  // adjustable at runtime (1..8), so a numbered diagram would be wrong as soon as it is changed.
  readonly workQueue: DiagramDefinition = {
    architecture: `flowchart TB
    subgraph Producers["🏭 Producers"]
        P1["Producer"]
    end
    subgraph Redis["🔴 Redis"]
        JS[("📥 jobs.imageProcessing.v1<br/>Stream")]
        DLQ[("⚠️ jobs.imageProcessing.v1:dlq<br/>Dead Letter Queue")]
        LUA["📜 Lua<br/>read_claim_or_dlq"]
        LUA -->|XREADGROUP<br/>jobs-group| JS
        LUA -->|"XADD<br/>(if deliveries ≥ maxDeliveries)"| DLQ
    end
    subgraph Workers["⚙️ Workers (1..8, adjustable)"]
        W1["Worker 1"]
        W2["Worker 2"]
        WE["⋯"]
        WN["Worker N"]
    end
    subgraph Done["✅ Done Streams"]
        D1[("jobs.done.worker-1")]
        D2[("jobs.done.worker-2")]
        DE["⋯"]
        DN[("jobs.done.worker-N")]
    end
    P1 -->|XADD| JS
    W1 -->|"poll<br/>FCALL"| LUA
    W2 -->|"poll<br/>FCALL"| LUA
    WN -->|"poll<br/>FCALL"| LUA
    W1 -->|XADD| D1
    W2 -->|XADD| D2
    WN -->|XADD| DN
    style Redis fill:#dc382d,color:#fff
    style JS fill:#3498db,color:#fff
    style DLQ fill:#6b7280,color:#fff
    style LUA fill:#f39c12,color:#000`,
    sequence: `sequenceDiagram
    participant P as Producer
    participant R as jobs.imageProcessing.v1
    participant LUA as Lua read_claim_or_dlq
    participant W1 as Worker 1
    participant W2 as Worker 2
    P->>R: XADD job1
    P->>R: XADD job2
    W1->>LUA: FCALL read_claim_or_dlq
    LUA-->>W1: job1
    W2->>LUA: FCALL read_claim_or_dlq
    LUA-->>W2: job2
    W1->>R: XADD done + XACK job1
    Note over W2: worker killed before XACK
    W1->>LUA: FCALL (next poll)
    LUA-->>W1: job2 reclaimed (idle > minIdle)
    W1->>R: XADD done + XACK job2`
  };

  readonly fanOut: DiagramDefinition = {
    architecture: `flowchart TB
    subgraph Producer["🏭 Producer"]
        P1["Event Publisher"]
    end
    subgraph Workers["⚙️ Workers"]
        W1["&nbsp;&nbsp;Analytics Service&nbsp;&nbsp;"]
        W2["Notification Service"]
        W3["&nbsp;&nbsp;&nbsp;&nbsp;Audit Service&nbsp;&nbsp;&nbsp;&nbsp;"]
    end
    subgraph Redis["🔴 Redis"]
        subgraph DoneStreams["✅ Done Streams"]
            D1[("&nbsp;&nbsp;analytics.done&nbsp;&nbsp;")]
            D2[("notifications.done")]
            D3[("&nbsp;&nbsp;&nbsp;&nbsp;audit.done&nbsp;&nbsp;&nbsp;&nbsp;")]
        end
        ES[("📥 events.fanout.v1<br/>Stream")]
        subgraph DLQSection["⚠️ DLQ"]
            LUA["📜 Lua<br/>read_claim_or_dlq"]
            DLQ[("events.fanout.v1:dlq")]
        end
        LUA -->|XREADGROUP| ES
        LUA -->|"XADD<br/>(if deliveries ≥ maxDeliveries)"| DLQ
    end
    P1 -->|XADD| ES
    W1 -->|"poll<br/>FCALL"| LUA
    W2 -->|"poll<br/>FCALL"| LUA
    W3 -->|"poll<br/>FCALL"| LUA
    W1 -->|XADD| D1
    W2 -->|XADD| D2
    W3 -->|XADD| D3
    style Redis fill:#dc382d,color:#fff
    style ES fill:#3498db,color:#fff
    style DLQ fill:#6b7280,color:#fff
    style LUA fill:#f39c12,color:#000
    style DoneStreams fill:#2ecc71,color:#fff
    style DLQSection fill:#e74c3c,color:#fff`,
    sequence: `sequenceDiagram
    participant P as Publisher
    participant R as Redis Stream
    participant A as Analytics
    participant N as Notifications
    participant Au as Audit
    P->>R: XADD event
    par Fan-Out
        R-->>A: event copy
        R-->>N: event copy
        R-->>Au: event copy
    end
    A->>R: XACK
    N->>R: XACK
    Au->>R: XACK`
  };

  readonly tokenBucket: DiagramDefinition = {
    architecture: `flowchart TB
    subgraph Producers["🏭 Producers"]
        P1["Job Submitter"]
    end
    subgraph Redis["🔴 Redis"]
        JS[("📥 token-bucket.jobs.v1<br/>Stream")]
        LUA["📜 Lua<br/>acquire_token"]
        subgraph Counters["🔢 Concurrency Counters"]
            C1["running:payment<br/>max=3"] ~~~ C2["running:email<br/>max=2"] ~~~ C3["running:csv<br/>max=1"]
        end
        CFG[("⚙️ config<br/>Hash")]
        LUA -->|"GET + INCR"| Counters
    end
    subgraph Workers["⚙️ 18 Workers"]
        W1["Worker 1..6"] ~~~ W2["Worker 7..12"] ~~~ W3["Worker 13..18"]
    end
    P1 -->|XADD| JS
    JS -->|XREADGROUP| Workers
    Workers -->|HGET max| CFG
    Workers -->|"FCALL(max)"| LUA
    style Redis fill:#dc382d,color:#fff
    style LUA fill:#f39c12,color:#000
    style Counters fill:#1e3a5f,color:#fff
    style C1 fill:#3b82f6,color:#fff
    style C2 fill:#10b981,color:#fff
    style C3 fill:#f59e0b,color:#000`,
    sequence: `sequenceDiagram
    participant P as Producer
    participant R as Redis
    participant W as Worker
    participant TB as Token Bucket
    participant EXT as External API
    P->>R: XADD {type: payment}
    W->>R: XREADGROUP
    W->>TB: INCR running:payment
    Note over W: running <= max?
    alt Token Available
        W->>EXT: Process job
        EXT-->>W: Done
        W->>TB: DECR running:payment
        W->>R: XACK
    else No Token
        W->>TB: DECR running:payment
        Note over W: Wait & retry
    end`
  };

  readonly perKeySerialized: DiagramDefinition = {
    architecture: `flowchart TB
    subgraph Producers["🏭 Producers"]
        P1["Order Service"]
    end
    subgraph Redis["🔴 Redis"]
        JS[("📥 jobs.perkey.v1<br/>Stream")]
        L1["🔒 running:order:ORD-001"]
        L2["🔒 running:order:ORD-002"]
        L3["🔒 running:order:ORD-003"]
        CG["Consumer Group<br/>jobs-serialized-group"]
        JS --> CG
    end
    subgraph Workers["⚙️ Workers"]
        W1["Worker 1"]
        W2["Worker 2"]
        W3["Worker 3"]
    end
    P1 -->|XADD| JS
    CG -->|XREADGROUP| W1
    CG -->|XREADGROUP| W2
    CG -->|XREADGROUP| W3
    W1 <-.->|SET NX/DEL| L1
    W2 <-.->|SET NX/DEL| L2
    W3 <-.->|SET NX/DEL| L3
    style Redis fill:#dc382d,color:#fff
    style L1 fill:#9b59b6,color:#fff
    style L2 fill:#9b59b6,color:#fff
    style L3 fill:#9b59b6,color:#fff`,
    sequence: `sequenceDiagram
    participant P as Producer
    participant R as Redis
    participant W1 as Worker 1
    participant W2 as Worker 2
    participant L as Lock Keys
    P->>R: XADD {orderId: ORD-001, step: 1}
    P->>R: XADD {orderId: ORD-001, step: 2}
    W1->>R: XREADGROUP -> step 1
    W1->>L: SET running:ORD-001 NX
    L-->>W1: OK (locked)
    W2->>R: XREADGROUP -> step 2
    W2->>L: SET running:ORD-001 NX
    L-->>W2: NIL (already locked!)
    Note over W2: Skip, retry later
    W1->>L: DEL running:ORD-001
    W1->>R: XACK step 1
    Note over W2: Now can process step 2`
  };

  readonly dlq: DiagramDefinition = {
    architecture: `flowchart TB
    subgraph Producer["🏭 Producer"]
        P1["Message Producer"]
    end
    subgraph Redis["🔴 Redis"]
        MS[("📥 test-stream<br/>Main Stream")]
        subgraph DLQSection["⚠️ DLQ"]
            LUA["📜 Lua<br/>read_claim_or_dlq"]
            DLQ[("test-stream:dlq")]
        end
        LUA -->|"XREADGROUP<br/>test-group"| MS
        LUA -->|"XADD<br/>(if deliveries ≥ maxDeliveries)"| DLQ
    end
    subgraph Consumer["⚙️ Consumer"]
        C1["Worker"]
    end
    P1 -->|XADD| MS
    C1 -->|"poll<br/>FCALL"| LUA
    C1 -->|XACK| MS
    style Redis fill:#dc382d,color:#fff
    style DLQ fill:#6b7280,color:#fff
    style LUA fill:#f39c12,color:#000
    style MS fill:#3498db,color:#fff
    style DLQSection fill:#e74c3c,color:#fff`,
    sequence: `sequenceDiagram
    participant P as Producer
    participant R as Redis Stream
    participant LUA as Lua Function
    participant W as Worker
    participant DLQ as Dead Letter Queue
    P->>R: XADD message
    W->>LUA: FCALL read_claim_or_dlq
    LUA-->>W: Message (delivery: 1)
    Note over W: Processing fails
    W->>LUA: FCALL read_claim_or_dlq
    LUA-->>W: Message (delivery: 2)
    Note over W: Processing fails again
    W->>LUA: FCALL read_claim_or_dlq
    Note over LUA: delivery >= maxDeliveries
    LUA->>DLQ: XADD to DLQ
    LUA->>R: XACK
    LUA-->>W: DLQ notification`
  };

  readonly pubsub: DiagramDefinition = {
    architecture: `flowchart TB
    subgraph Publishers["🏭 Publishers"]
        P1["Publisher"]
    end
    subgraph Redis["🔴 Redis"]
        CH["📡 Channel<br/>news"]
    end
    subgraph Subscribers["👥 Subscribers"]
        S1["Subscriber A"]
        S2["Subscriber B"]
        S3["Subscriber C"]
    end
    P1 -->|PUBLISH| CH
    CH -->|PUSH| S1
    CH -->|PUSH| S2
    CH -->|PUSH| S3
    style Redis fill:#dc382d,color:#fff
    style CH fill:#3498db,color:#fff`,
    sequence: `sequenceDiagram
    participant P as Publisher
    participant R as Redis
    participant S1 as Subscriber A
    participant S2 as Subscriber B
    S1->>R: SUBSCRIBE news
    S2->>R: SUBSCRIBE news
    P->>R: PUBLISH news "Hello!"
    par Real-time Push
        R-->>S1: "Hello!"
        R-->>S2: "Hello!"
    end
    Note over P: Fire & Forget`
  };

  readonly requestReply: DiagramDefinition = {
    architecture: `flowchart TB
    subgraph Client["🖥️ Client"]
        REQ["Requester"]
    end
    subgraph Redis["🔴 Redis"]
        subgraph LuaSection[" "]
            direction LR
            LUA_REQ["📜 Lua<br/>request"]
            LUA_RES["📜 Lua<br/>response"]
        end
        RS[("📥 request.stream.v1")]
        RES[("📤 response.stream.v1")]
        TK["⏱️ timeout:*<br/>SET + TTL"]
        SK["👻 shadow:*<br/>HSET + TTL+10"]
        KS["🔔 Keyspace<br/>Notifications"]
        TK -.->|"expire"| KS
    end
    subgraph Workers["⚙️ Workers"]
        W1["&nbsp;&nbsp;Request Worker&nbsp;&nbsp;"]
        W2["Keyspace Listener"]
    end
    REQ -->|"FCALL request"| LUA_REQ
    LUA_REQ -->|"XADD"| RS
    LUA_REQ -->|"SET EX"| TK
    LUA_REQ -->|"HSET + EXPIRE"| SK
    W1 -->|"FCALL read_claim_or_dlq"| RS
    W1 -->|"FCALL response"| LUA_RES
    LUA_RES -->|"DEL"| TK
    LUA_RES -->|"XADD"| RES
    KS -.->|"onExpire"| W2
    W2 -->|"HGETALL"| SK
    W2 -->|"XADD TIMEOUT"| RES
    REQ -->|"XREADGROUP<br/>polling"| RES
    style Redis fill:#dc382d,color:#fff
    style LuaSection fill:transparent,stroke:transparent
    style TK fill:#e74c3c,color:#fff
    style SK fill:#9b59b6,color:#fff
    style LUA_REQ fill:#f39c12,color:#000
    style LUA_RES fill:#f39c12,color:#000
    style KS fill:#3498db,color:#fff
    style W2 fill:#27ae60,color:#fff`,
    sequence: `sequenceDiagram
    participant C as Client
    participant LUA_REQ as Lua request
    participant LUA_RES as Lua response
    participant RQ as Request Stream
    participant W as Request Worker
    participant KL as Keyspace Listener
    participant RS as Response Stream
    participant TK as Timeout Key
    participant SK as Shadow Key
    C->>LUA_REQ: FCALL request {orderId, timeout}
    LUA_REQ->>RQ: XADD request
    LUA_REQ->>TK: SET EX timeout
    LUA_REQ->>SK: HSET + EXPIRE timeout+10
    LUA_REQ-->>C: correlationId
    par Polling for response
        C->>RS: XREADGROUP (polling)
    and Worker processes
        W->>RQ: FCALL read_claim_or_dlq
        Note over W: Processing...
        W->>LUA_RES: FCALL response
        LUA_RES->>TK: DEL (cancel timeout)
        LUA_RES->>RS: XADD response
    end
    RS-->>C: Response received
    Note over C,RS: --- Alternative: Timeout ---
    Note over TK: ⏰ Key expires
    TK-->>KL: Keyspace notification
    KL->>SK: HGETALL (get metadata)
    KL->>RS: XADD TIMEOUT response
    RS-->>C: TIMEOUT response`
  };

  readonly contentBasedRouting: DiagramDefinition = {
    architecture: `flowchart TB
    subgraph Top[" "]
        direction LR
        subgraph Producers["🏭 Producers"]
            P1["Payment Submitter"]
        end

        subgraph Workers["⚙️ Workers"]
            W1["Standard"]
            W2["Premium"]
            W3["VIP"]
        end
    end

    subgraph RouterBox["🔀 Content Router"]
        CR["Routes by amount"]
    end

    subgraph Redis["🔴 Redis"]
        IN[("📥 incoming")]
        STD[("📦 payments.standard.v1<br/>≤ $1,000")]
        PRM[("📦 payments.premium.v1<br/>$1K - $10K")]
        VIP[("📦 payments.vip.v1<br/>> $10,000")]
        subgraph DLQSection["⚠️ DLQ"]
            LUA["📜 Lua<br/>read_claim_or_dlq"]
            DLQ[("payments.dlq")]
        end
    end

    P1 -->|XADD| IN
    IN -->|XREADGROUP| CR
    CR -->|"XADD ≤$1K"| STD
    CR -->|"XADD $1K-$10K"| PRM
    CR -->|"XADD >$10K"| VIP

    W1 -->|poll| LUA
    W2 -->|poll| LUA
    W3 -->|poll| LUA

    LUA -->|XREADGROUP| STD
    LUA -->|XREADGROUP| PRM
    LUA -->|XREADGROUP| VIP
    LUA -->|"XADD<br/>(if deliveries ≥ maxDeliveries)"| DLQ

    style Top fill:transparent,stroke:transparent
    style Redis fill:#dc382d,color:#fff
    style RouterBox fill:#9b59b6,color:#fff
    style LUA fill:#f39c12,color:#000
    style STD fill:#2ecc71,color:#fff
    style PRM fill:#f39c12,color:#000
    style VIP fill:#e74c3c,color:#fff
    style DLQ fill:#6b7280,color:#fff
    style DLQSection fill:#e74c3c,color:#fff`,
    sequence: `sequenceDiagram
    autonumber
    participant P as Producer
    participant IN as payments.incoming.v1
    participant CR as Content Router
    participant STD as payments.standard.v1
    participant DLQ as payments.standard.v1:dlq
    participant LUA as Lua Script
    participant W as Standard Worker

    P->>IN: XADD {amount: -100}

    CR->>IN: XREADGROUP
    IN-->>CR: {amount: -100}
    Note over CR: -100 ≤ 1000 → Standard
    CR->>STD: XADD
    CR->>IN: XACK

    W->>LUA: poll for messages
    LUA->>STD: XREADGROUP
    STD-->>LUA: {amount: -100}
    LUA-->>W: message
    Note over W: Process fails!<br/>Exception thrown
    Note over W: No XACK sent

    W->>LUA: poll (retry 1)
    LUA->>STD: XREADGROUP + XCLAIM
    Note over LUA: deliveries = 2 (claimed again)
    STD-->>LUA: {amount: -100}
    LUA-->>W: message
    Note over W: Process fails again!

    W->>LUA: poll (sweep)
    LUA->>STD: XPENDING → XCLAIM
    Note over LUA: deliveries = 2 ≥ maxDeliveries<br/>sweep — not redelivered
    LUA->>DLQ: XADD (move to DLQ)
    LUA->>STD: XACK (remove from stream)
    Note over DLQ: Message in DLQ<br/>for manual review`
  };

  readonly topicRouting: DiagramDefinition = {
    architecture: `flowchart TB
    subgraph Publishers["☕ Publishers (Java)"]
        P1["Event Publisher"]
    end
    subgraph Redis["🔴 Redis Pub/Sub"]
        CH1["📡 orders.created"]
        CH2["📡 orders.updated"]
        CH3["📡 payments.created"]
        CH4["📡 payments.failed"]
    end
    subgraph Subscribers["☕ Pattern Subscribers (Java)"]
        S1["Subscriber A<br/>orders.*"]
        S2["Subscriber B<br/>payments.*"]
        S3["Subscriber C<br/>*.created"]
    end
    P1 -->|PUBLISH| CH1
    P1 -->|PUBLISH| CH2
    P1 -->|PUBLISH| CH3
    P1 -->|PUBLISH| CH4
    CH1 -.->|match| S1
    CH2 -.->|match| S1
    CH1 -.->|match| S3
    CH3 -.->|match| S2
    CH4 -.->|match| S2
    CH3 -.->|match| S3
    style Redis fill:#dc382d,color:#fff
    style S1 fill:#3498db,color:#fff
    style S2 fill:#2ecc71,color:#fff
    style S3 fill:#9b59b6,color:#fff`,
    sequence: `sequenceDiagram
    participant P as Publisher
    participant R as Redis
    participant S1 as Sub (orders.*)
    participant S2 as Sub (*.created)
    S1->>R: PSUBSCRIBE orders.*
    S2->>R: PSUBSCRIBE *.created
    P->>R: PUBLISH orders.created
    par Pattern Match
        R-->>S1: Match orders.*
        R-->>S2: Match *.created
    end
    P->>R: PUBLISH orders.updated
    R-->>S1: Match orders.*
    Note over S2: No match`
  };

  readonly scheduledMessages: DiagramDefinition = {
    architecture: `flowchart TB
    subgraph Producers["🏭 Producers"]
        P1["Scheduler"]
    end
    subgraph Redis["🔴 Redis"]
        ZS[("📅 scheduled:messages<br/>Sorted Set")]
        TS[("📥 reminders.v1<br/>Target Stream")]
    end
    subgraph PollingService["☕ Polling Service (Java)"]
        POLL["⏰ ScheduledMessageService"]
    end
    subgraph Workers["⚙️ Workers"]
        W1["Message Processor"]
    end
    P1 -->|ZADD score=timestamp| ZS
    POLL -->|"1. ZRANGEBYSCORE 0 {now}"| ZS
    POLL -->|2. XADD| TS
    POLL -->|3. ZREM| ZS
    TS -->|XREADGROUP| W1
    style Redis fill:#dc382d,color:#fff
    style ZS fill:#f39c12,color:#000
    style PollingService fill:#9b59b6,color:#fff`,
    sequence: `sequenceDiagram
    participant P as Producer
    participant ZS as Sorted Set
    participant POLL as Scheduler
    participant TS as Target Stream
    P->>ZS: ZADD score=future_ts
    loop Every second
        POLL->>ZS: ZRANGEBYSCORE 0 {now}
    end
    Note over POLL: Time reached!
    ZS-->>POLL: Message (due)
    POLL->>TS: XADD
    POLL->>ZS: ZREM`
  };

  readonly keyRouting: DiagramDefinition = {
    architecture: `flowchart LR
    subgraph Management["🔧 Management"]
        UI["🅰️ Angular<br/>Rules Manager"]
        REST["☕ Spring Boot<br/>REST API"]
        UI --> REST
    end
    subgraph Producers["☕ Producers (Java)"]
        P1["Event Publisher"]
    end
    subgraph Redis["🔴 Redis"]
        direction TB
        RULES[("📋 routing:rules:*<br/>HashMap")]
        LUA["📜 Lua<br/>route_message"]
        LUA -.->|"HGETALL"| RULES
        EX[("&nbsp;&nbsp;&nbsp;&nbsp;📥 Exchange&nbsp;&nbsp;&nbsp;&nbsp;")]
        LUA -->|"XADD"| EX
        S1[("&nbsp;&nbsp;events.order.v1&nbsp;&nbsp;")]
        S2[("&nbsp;&nbsp;events.order.v2&nbsp;&nbsp;")]
        S3[("&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;events.vip&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;")]
        S4[("&nbsp;&nbsp;&nbsp;&nbsp;events.gdpr&nbsp;&nbsp;&nbsp;&nbsp;")]
        LUA -->|"XADD"| S1
        LUA -->|"XADD"| S2
        LUA -->|"XADD"| S3
        LUA -->|"XADD"| S4
    end
    subgraph Workers["⚙️ Workers"]
        W1["&nbsp;&nbsp;&nbsp;Order V1&nbsp;&nbsp;&nbsp;"]
        W2["&nbsp;&nbsp;&nbsp;Order V2&nbsp;&nbsp;&nbsp;"]
        W3["&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;VIP&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"]
        W4["&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;GDPR&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"]
    end
    REST -->|"HSET/HDEL"| RULES
    P1 -->|"FCALL"| LUA
    S1 --> W1
    S2 --> W2
    S3 --> W3
    S4 --> W4
    style Management fill:#2c3e50,color:#fff
    style Redis fill:#dc382d,color:#fff
    style Workers fill:#34495e,color:#fff
    style LUA fill:#f39c12,color:#000
    style RULES fill:#9b59b6,color:#fff
    style UI fill:#dd0031,color:#fff
    style REST fill:#6db33f,color:#fff`,
    sequence: `sequenceDiagram
    autonumber
    participant UI as Angular UI
    participant API as Spring Boot API
    participant Redis as Redis
    participant LUA as Lua route_message
    participant W as Workers
    Note over UI,API: Rule Management (CRUD)
    UI->>API: Create/Update Rule
    API->>Redis: HSET routing:rules:* {rule JSON}
    Note over Redis,LUA: Message Routing
    API->>LUA: FCALL route_message(routingKey, payload)
    LUA->>Redis: HGETALL routing:rules:*
    Redis-->>LUA: Rules list
    Note over LUA: Evaluate Lua patterns<br/>against routing key
    LUA->>Redis: XADD events.topic.v1 (exchange)
    LUA->>Redis: XADD events.order.v1 (if match)
    LUA->>Redis: XADD events.vip (if match)
    Note over Redis,W: Message Consumption
    W->>Redis: XREADGROUP events.order.v1
    Redis-->>W: Messages`
  };

  readonly llmChat: DiagramDefinition = {
    architecture: `flowchart TB
    UI["🖥️ Angular /llm-chat"]

    subgraph Redis["🔴 Redis"]
        S[("💬 chat:cid<br/>Conversation Stream")]
        T[("⌨️ chat:cid:tok<br/>Token Stream (capped)")]
        F[("🚩 chat:cid:flags")]
        ST[("📈 chat:cid:stats + ts:cid:userTokens")]
        DLQ[("💀 chat:cid:dlq")]
    end

    subgraph Workers["⚙️ Virtual Threads (per conversation) — fan-out: 3 groups, same stream"]
        R["🤖 Responder<br/>cg:responder"]
        M["🛡️ Moderation<br/>cg:moderation"]
        A["📊 Analytics<br/>cg:analytics"]
        SW["♻️ Recovery Sweeper<br/>XAUTOCLAIM"]
        TL["📡 Token Listener"]
    end

    LLM["🧠 LlmClient (mock)"]

    UI -->|"POST message<br/>XADD role=user"| S
    S -->|"XREADGROUP cg:responder"| R
    S -->|"XREADGROUP cg:moderation"| M
    S -->|"XREADGROUP cg:analytics"| A
    R -->|"XREVRANGE (context)"| S
    R -->|"generate"| LLM
    R -->|"XADD token"| T
    R -->|"XADD role=assistant + XACK"| S
    M -->|"XADD flag (keyword)"| F
    A -->|"HINCRBY / TS.ADD"| ST
    SW -->|"XAUTOCLAIM stale pending → regenerate"| S
    SW -->|"XADD (max deliveries)"| DLQ
    T -->|"XREAD BLOCK"| TL
    TL -->|"WebSocket (filtered by cid)"| UI

    style Redis fill:#dc382d,color:#fff
    style S fill:#3498db,color:#fff
    style T fill:#8e44ad,color:#fff
    style F fill:#e11d48,color:#fff
    style ST fill:#0891b2,color:#fff
    style DLQ fill:#6b7280,color:#fff
    style LLM fill:#f39c12,color:#000`,
    sequence: `sequenceDiagram
    autonumber
    participant U as Angular UI
    participant S as chat:cid
    participant R as Responder (VT)
    participant L as LlmClient (mock)
    participant T as chat:cid:tok
    participant TL as Token Listener (VT)

    U->>S: XADD role=user
    R->>S: XREADGROUP cg:responder
    R->>S: XREVRANGE (rebuild context)
    R->>L: generate(context)
    loop each token
        L-->>R: token
        R->>T: XADD token
        TL->>T: XREAD BLOCK
        TL-->>U: WS TOKEN (progressive render)
    end
    R->>S: XADD role=assistant (full text)
    R->>S: XACK (user message processed)`
  };
}

