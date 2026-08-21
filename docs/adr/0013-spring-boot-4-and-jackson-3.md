# ADR-0013 — Spring Boot 4.1.1, and Jackson 3 (`tools.jackson`) as the JSON stack

- **Status:** Accepted
- **Date:** 2026-08-21
- **Context:** dependency-refresh pass that also took Jedis to 8.0.0 (see ADR-0011 for XNACK itself)

## Context

The project sat on Spring Boot 3.5.7 while 4.1.1 was the current stable. Boot 4 is not a drop-in
bump: it brings Spring Framework 7 and, more consequentially here, **switches the auto-configured
JSON stack from Jackson 2 (`com.fasterxml.jackson.databind`) to Jackson 3 (`tools.jackson`)**.

A first attempt was rejected on evidence: production code compiled untouched, but the `@WebMvcTest`
slices failed with `No qualifying bean of type 'com.fasterxml.jackson.databind.ObjectMapper'` — Boot 4
no longer auto-configures a Jackson 2 mapper. Staying on Jackson 2 while Boot's HTTP and WebSocket
converters use Jackson 3 was never a real option: the DTO annotations would be read by one library and
the payloads written by another, which fails silently rather than loudly.

## Decision

**Go to Boot 4.1.1 and migrate to Jackson 3 wholesale.** Concretely:

- `spring-boot-starter-parent` 3.5.7 → 4.1.1.
- The `jackson-databind` dependency changes groupId: `com.fasterxml.jackson.core` → `tools.jackson.core`.
- 14 files move to the new packages: `ObjectMapper` and `JsonNode` → `tools.jackson.databind`,
  `TypeReference` → `tools.jackson.core.type`, and `JsonProcessingException` →
  **`tools.jackson.core.JacksonException`**, which is *unchecked* in Jackson 3.
- **Annotations do not move.** `@JsonFormat` and friends stay in `com.fasterxml.jackson.annotation` —
  the one `com.fasterxml` import left in the codebase is correct, not an oversight.
- `@WebMvcTest` moves to `org.springframework.boot.webmvc.test.autoconfigure`, in a new
  `spring-boot-starter-webmvc-test` artifact that `spring-boot-starter-test` no longer drags in.

## Verification

The suite (93 tests) covers 3 of the 12 patterns and **nothing covers the WebSocket path**, which is
exactly where a JSON-stack swap hides. So the migration was checked against a running stack as well:

- Boot 4.1.1 / Spring 7.0.9 confirmed at runtime, 0 ERROR on startup.
- 23 of 23 GET endpoints across all 12 patterns return HTTP 200 with parseable JSON.
- The WebSocket stream delivers events that all parse (`MESSAGE_PRODUCED`, `MESSAGE_DELETED`), proving
  Jackson 3 serializes `DLQEvent` on the live path.
- `@JsonFormat(pattern = "…SSS")` is still honoured: `"timestamp":"2026-08-21T08:41:57.389"`.
- Request/Reply round-trips `writeValueAsString` → Lua `request` → worker `readValue` with a
  `TypeReference` → OK response → XACK.

## Consequences

- `catch (JacksonException e)` blocks now catch an unchecked exception. They still compile and still
  work, but the compiler no longer forces the catch — new code can forget it silently.
- Any future dependency that expects a Jackson 2 `ObjectMapper` bean will not find one.
- Jackson 3 rejects `readValue(null)` with `argument "content" is null`. The Request/Reply worker
  passes a stream field straight to `readValue`, so a request missing `items` produces that error and
  an ERROR reply instead of a clean 400. Pre-existing shape, now with a blunter failure message.
