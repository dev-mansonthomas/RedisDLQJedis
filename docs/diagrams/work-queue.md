# Work Queue Pattern

> Names, worker count and guarantees come from `WorkQueueService`. Corrected 2026-08-11: this file
> still carried `jobs.workqueue.v1` / `job-queue-group` / `workerN.done` and a fixed 3 workers (the
> same drift fixed in `diagram-definitions.service.ts`), and it claimed *exactly-once* delivery,
> which Redis Streams consumer groups do **not** provide.

## Architecture Diagram

```mermaid
flowchart TB
    subgraph Producers["🏭 Producers"]
        P1["Producer"]
    end

    subgraph Redis["🔴 Redis"]
        JS[("📥 jobs.imageProcessing.v1<br/>Stream")]
        DLQ[("⚠️ jobs.imageProcessing.v1:dlq<br/>Dead Letter Queue")]
        LUA["📜 Lua<br/>read_claim_or_dlq"]
        LUA -->|"XREADGROUP … CLAIM<br/>group jobs-group"| JS
        LUA -->|"XADD<br/>(if deliveries ≥ maxDeliver = 2)"| DLQ
    end

    subgraph Workers["⚙️ Workers (1–8, 4 at startup)"]
        W1["Worker 1"]
        W2["Worker 2"]
        WN["Worker N"]
    end

    subgraph Done["✅ Done Streams"]
        D1[("jobs.done.worker-1")]
        D2[("jobs.done.worker-2")]
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
    style LUA fill:#f39c12,color:#000
```

## Sequence Diagram

```mermaid
sequenceDiagram
    autonumber
    participant P as Producer
    participant R as jobs.imageProcessing.v1
    participant CG as Consumer Group jobs-group
    participant W1 as worker-1
    participant W2 as worker-2

    P->>R: XADD jobs.imageProcessing.v1 {jobId, processingType, createdAt}
    P->>R: XADD jobs.imageProcessing.v1 {jobId, processingType, createdAt}

    Note over CG: Each entry goes to whichever consumer asks first —<br/>not round-robin

    W1->>CG: FCALL read_claim_or_dlq … jobs-group worker-1
    CG-->>W1: entry 1 (now in worker-1's PEL)

    W2->>CG: FCALL read_claim_or_dlq … jobs-group worker-2
    CG-->>W2: entry 2 (now in worker-2's PEL)

    Note over W1: Processing (simulated work)
    W1->>R: XADD jobs.done.worker-1 {result}
    W1->>R: XACK jobs.imageProcessing.v1 jobs-group entry 1

    Note over W2: Worker dies mid-job — no XACK
    W2--xR: (nothing)
    Note over CG: entry 2 stays in worker-2's PEL

    W1->>CG: FCALL read_claim_or_dlq … (after minIdle)
    CG-->>W1: entry 2, reclaimed (delivery count +1)
```

## Key Points

- **Load balancing**: one consumer group, N consumers — each entry is delivered to exactly one of
  them. Distribution is *not* round-robin: whoever polls first gets the entry, so a fast consumer
  legitimately takes more.
- **At-least-once, not exactly-once**: `XADD` to the done stream and `XACK` are two commands, so a
  crash between them re-delivers the job and produces a duplicate done entry. Downstream consumers
  must be idempotent.
- **No job lost when a worker dies**: the un-ACKed entry stays in that consumer's PEL and is
  reclaimed by a peer once it has been idle for `minIdle`.
- **`minIdle` must outlast the processing time** (the demo enforces `minIdle >= 2 × work` in
  `WorkQueueService.DemoMode`). Otherwise a *free* worker claims a job its busy peer is still running
  and the job is processed twice, silently.
- **Never `XGROUP DELCONSUMER` a consumer that still has PEL entries** — they leave the PEL with it
  and those jobs are lost. Stop the loop and let the claim path recover them.
- **Bounded retry then DLQ**: a job delivered `maxDeliver` (2) times is swept to
  `jobs.imageProcessing.v1:dlq` by the next poll.
- **Visibility**: each worker writes to its own `jobs.done.worker-{id}` stream. That is a *measuring
  device for the demo*, not a production practice.
