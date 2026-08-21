# ADR-0012 — Redis state is ephemeral; every launch starts from an empty keyspace

- **Status:** Accepted
- **Date:** 2026-08-20
- **Supersedes:** the `redis-data` volume + `--appendonly yes` introduced with the original compose file

## Context

This repo is an educational demo: its whole point is that a Redis Solution Architect can put the
app next to RedisInsight and *show* the keyspace — streams, consumer groups, PELs, sorted sets.

The original `docker-compose.yml` gave Redis a named volume (`redis-data:/data`) and enabled AOF
(`--appendonly yes`), so state accumulated across runs. Nothing in the app needs that:

- 9 services already wipe their own demo streams in their `CommandLineRunner`, so cross-run state
  was never part of any pattern's contract;
- the two that don't — **DLQ** (`test-stream`) and **LLM Chat** (durable by design — `LlmChatService.reset(cid)`
  is its only deleter) — were the ones leaking. A live instance had accumulated 230 keys,
  including ~60 LLM Chat test conversations (`chat:measure:*`, `ts:*:userTokens`) and 27 stray
  `memtier-*` keys from an unrelated benchmark;
- that leftover noise is precisely what makes a demo hard to read: the audience cannot tell which
  keys the pattern just created from which ones were already there.

## Decision

**Redis holds no state between runs, and the launcher guarantees an empty keyspace.** Two layers,
because either one alone leaves a hole:

1. **Ephemeral container** — no volume, `redis-server --save "" --appendonly no`. Nothing survives a
   container recreate, and the demo stops paying for AOF writes it never reads.
2. **`FLUSHALL` in `launch-docker.sh`** — layer 1 does nothing when the Redis container is *already
   running* (`docker compose up -d` is then a no-op), which is the common case when relaunching
   between two demos. The script therefore flushes explicitly.

**Ordering is the load-bearing part of layer 2.** The backend creates its consumer groups in its
`CommandLineRunner`s and nowhere else. `FLUSHALL` deletes streams *and* groups, so flushing under a
running backend leaves every claim-based pattern reading a group that no longer exists. The script
consequently does: `stop backend` → `up -d redis` → wait for `healthy` → `FLUSHALL` → `up -d`
(which starts the backend, recreating the groups against the empty keyspace). If Redis does not
become healthy within 60s the script aborts rather than starting on an unknown state.

`--keep-data` opts out of layer 2 for the rare case of inspecting what a run left behind.

## Consequences

- Every `./launch-docker.sh` is a reproducible cold start; screenshots and blog measurements no
  longer depend on how many demos ran before.
- **The LLM Chat conversation no longer survives a stack relaunch.** It still survives a *page
  reload* — the frontend keeps the cid in `localStorage` and `chat:{cid}` is the source of truth —
  which is the behaviour the LLM Chat spec actually guards. Relaunching the stack now resets it.
- A relaunch over a running stack costs one backend restart (~10s) it did not cost before.
- `FLUSHALL` does **not** remove the Lua library — verified on a throwaway `redis:8.8-alpine`
  (`FUNCTION LIST` reports the library before and after). `RedisLuaFunctionLoader` re-registers it
  on every startup anyway, so the functions are present either way.
- The legacy `redismessagingpatternswithjedis_redis-data` volume is now orphaned; `./clean-docker.sh`
  (`down -v`) removes it.
