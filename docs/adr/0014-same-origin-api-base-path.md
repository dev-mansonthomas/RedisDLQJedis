# ADR-0014 — The frontend talks to the API same-origin, under a relative `/api`

- **Status:** accepted
- **Date:** 2026-08-28
- **Supersedes:** nothing. Complements [ADR-0008](0008-demo-grade-security-posture.md) (security posture).

## Context

Nineteen call sites in the Angular app hardcoded `http://localhost:8080/api/...` — three services
(`redis-api`, `routing-rules`, `llm-chat`), the WebSocket service, eleven pattern components and two
specs. It worked, so it was filed as a 🟡 portability chore.

It was more than that. `frontend/nginx.conf` **already** proxied `/api/` and `/api/ws` to
`backend:8080`, and had since the image was written. The absolute URLs bypassed that proxy: the
browser reached past nginx to the backend's published port, so every REST call and the SockJS
handshake were **cross-origin** requests to a different port on the same host. That is the only
reason the demo needed a CORS policy on its happy path at all. The dev server (`npm start`) had no
proxy configured, so absolute URLs were also the only thing making `ng serve` work — which is why
nobody noticed the proxy was unused.

## Decision

One constant, `API_BASE = '/api'`, in `frontend/src/app/api.config.ts`. Every call site builds a
**relative** path from it. Both supported run paths then put the API on the page's own origin:

| Run path | Who serves `/api` |
|----------|-------------------|
| Docker (`./launch-docker.sh`) | nginx proxies `/api/` and `/api/ws` → `backend:8080` (`frontend/nginx.conf`) |
| `npm start` | the dev server proxies `/api` → `localhost:8080` (`frontend/proxy.conf.json`, wired via `angular.json` → `serve.options.proxyConfig`) |

A new `proxy.conf.json` was required: relative URLs have nowhere to go under `ng serve` without it.
To point a dev session at a backend elsewhere, change that file's `target` — never a call site.

An eslint `no-restricted-syntax` rule (two selectors: `Literal` and `TemplateElement`) rejects any
`http(s)://localhost|127.0.0.1[:port]/api` string in `**/*.ts`, so the 19 cannot silently return.

## Consequences

- **The browser no longer makes a cross-origin request for the API on either run path.** Verified in
  a browser across `/dlq`, `/per-key-serialized`, `/work-queue` and `/llm-chat`: every `/api` request
  went to host `localhost:4200`, and a `Burst 200 jobs` click POSTed to
  `localhost:4200/api/work-queue/produce/burst` → 200, 0 console errors.
- **`CorsConfig` stays.** It is no longer on the happy path, but `docker-compose` still publishes
  8080, so a page or tool can still call the backend directly; the allow-list is what refuses a
  foreign origin there (measured: `Origin: https://evil.example` → 403). Removing it would trade a
  cheap, tested guard for nothing.
- **SockJS accepts a relative URL.** `url-parse` resolves it against `location` in a browser, so
  `new SockJS('/api/ws/dlq-events')` connects to the page's origin — measured, the socket upgraded to
  `ws://localhost:4200/api/ws/dlq-events/...`. It does *not* resolve under Node with no `location`,
  which is why a spec must never build a real SockJS (see `WebSocketServiceStub`).
- **Portability comes for free:** a different host, port, or TLS termination needs no rebuild, because
  nothing in the bundle names an origin.
- **Cost:** one indirection at every call site, and the dev server now depends on a proxy file. The
  failure mode if it is missing is loud (the SPA fallback answers `/api/...` with `index.html`), not
  silent.

## Alternatives considered

- **Angular `environment.ts` per build** — rejected: it puts the origin back *inside the bundle*, so
  one image can no longer serve two deployments, and it does not remove the cross-origin call.
- **A runtime global injected into `index.html`** (`window.__API_BASE__`) — rejected as speculative:
  no supported run path needs the API anywhere but the page's own origin. Reach for it the day one does.
- **Keep the absolute URLs and widen the CORS allow-list** — rejected: it keeps a proxy that already
  exists unused, and treats a configuration mistake as a policy problem.
