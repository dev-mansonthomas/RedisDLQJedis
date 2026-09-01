/**
 * Single source of truth for the backend's base path.
 *
 * Relative on purpose. Both supported run paths put the API on the page's own origin under
 * `/api`:
 *
 * - **Docker** — nginx serves the SPA and proxies `/api/` to `backend:8080` (`frontend/nginx.conf`).
 * - **`npm start`** — the dev server proxies `/api` to `localhost:8080` (`frontend/proxy.conf.json`).
 *
 * Same-origin is the point, not just tidiness: the absolute `localhost:8080` URLs this
 * replaced went straight to the published backend port, bypassing the nginx proxy that already
 * existed and turning every call into a cross-origin request. The relative form needs no CORS at
 * all, and it works unchanged behind a different host, port or TLS.
 *
 * SockJS accepts it too — `url-parse` resolves a relative URL against `location` in a browser, so
 * `new SockJS('/api/ws/dlq-events')` connects to the page's own origin.
 *
 * To point a dev session at a backend elsewhere, change the target in `proxy.conf.json`. Never
 * hardcode an absolute URL at a call site.
 */
export const API_BASE = '/api';
