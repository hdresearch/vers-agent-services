# Authentication & UI Access

How auth works in vers-agent-services. There are two layers: **bearer token auth** for API access and **session auth** (via magic links) for the browser dashboard.

---

## Bearer Token Auth (API)

All API endpoints (`/board/*`, `/feed/*`, `/log/*`, `/registry/*`, `/skills/*`, `/reports/*`, `/usage/*`, `/commits/*`, `/journal/*`) require a bearer token.

**Setup:** Set the `VERS_AUTH_TOKEN` environment variable on the server.

**Usage:** Include the token in every request:

```
Authorization: Bearer <token>
```

**Dev mode:** If `VERS_AUTH_TOKEN` is not set, all endpoints are open (no auth enforced). The server logs a warning at startup:

```
⚠️  VERS_AUTH_TOKEN is not set — all endpoints are unauthenticated.
```

**Responses:**
| Condition | Status | Body |
|---|---|---|
| Missing `Authorization` header | `401` | `{"error": "Unauthorized — missing Authorization header"}` |
| Invalid / wrong token | `401` | `{"error": "Unauthorized — invalid token"}` |

---

## Magic Link Auth (UI Dashboard)

The browser dashboard at `/ui/` uses session cookies, not bearer tokens. Users get in via a **magic link** flow — the bearer token never touches the browser.

### Flow

```
Agent/CLI                          Server                         Browser
   │                                 │                               │
   │  POST /auth/magic-link          │                               │
   │  Authorization: Bearer <token>  │                               │
   │ ──────────────────────────────► │                               │
   │                                 │                               │
   │  { url, expiresAt }            │                               │
   │ ◄────────────────────────────── │                               │
   │                                 │                               │
   │  (send URL to user)            │                               │
   │ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ►│
   │                                 │                               │
   │                                 │  GET /ui/login?token=<token>  │
   │                                 │ ◄──────────────────────────── │
   │                                 │                               │
   │                                 │  Set-Cookie: session=<id>     │
   │                                 │  Redirect → /ui/              │
   │                                 │ ─────────────────────────────►│
```

### Step by step

1. **Generate a magic link** — call `POST /auth/magic-link` with bearer auth. Response:

   ```json
   {
     "url": "https://host/ui/login?token=<one-time-token>",
     "expiresAt": "2026-02-12T18:19:27.000Z"
   }
   ```

   The URL is constructed from the request's `Host` header and `X-Forwarded-Proto` (defaults to `https`).

2. **One-time token** — the token in the URL is a concatenation of two ULIDs. It expires in **5 minutes** and can only be used once. After consumption it's deleted from the in-memory store.

3. **User clicks the link** — `GET /ui/login?token=...` validates the token. If valid, the server:
   - Creates a session (ULID-based ID, stored in memory)
   - Sets an `HttpOnly` cookie: `session=<id>; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
   - Redirects to `/ui/` via an HTML meta-refresh

4. **Session lasts 24 hours.** After that, the session is rejected and the user is redirected to `/ui/login`.

5. **Invalid/expired link** — returns `401` with an error page telling the user to request a new link.

### Expired session & token cleanup

A background interval (every 60 seconds) sweeps expired magic link tokens and expired sessions from memory.

---

## Unauthenticated Endpoints

These paths require **no auth at all**:

| Path | Purpose |
|---|---|
| `GET /health` | Liveness probe. Returns `{"status": "ok", "uptime": <seconds>}`. |
| `/ui/static/*` | Static assets (CSS, JS). Exempt from session middleware. |
| `/ui/login` | Login page / magic link consumer. Exempt from session middleware. |
| `GET /reports/shared/:shareId` | Public share links for reports (mounted before bearer auth middleware). |

---

## UI API Proxy

Browser JavaScript in the dashboard hits `/ui/api/*` instead of the API directly. The server proxies these requests to itself on `127.0.0.1`, **injecting the bearer token** server-side. This means:

- The browser **never sees or stores** the `VERS_AUTH_TOKEN`
- The proxy only requires a valid **session cookie** (enforced by the `/ui/*` middleware)
- The `/ui/api/` prefix is stripped: `/ui/api/board/tasks` → `GET /board/tasks` internally

### Proxy behavior

- **All HTTP methods** are forwarded (GET, POST, PUT, DELETE, etc.)
- **Query strings** are preserved
- **Request body** is forwarded for non-GET/HEAD methods
- **Content-Type** header is forwarded from the original request
- **SSE streams** (`text/event-stream` responses) are piped through transparently
- On proxy failure, returns `502` with `{"error": "Proxy error", "details": "..."}`

### Example

Browser JS:
```js
// No Authorization header needed — session cookie is enough
const resp = await fetch("/ui/api/feed/events");
```

The server rewrites this to:
```
GET http://127.0.0.1:3000/feed/events
Authorization: Bearer <VERS_AUTH_TOKEN>
```

---

## Summary

| Layer | Mechanism | Lifetime | Protects |
|---|---|---|---|
| Bearer token | `Authorization: Bearer` header, from `VERS_AUTH_TOKEN` env var | Indefinite (env var) | All `/api` routes (`/board`, `/feed`, etc.) |
| Magic link | One-time URL token | 5 minutes | Entry into session |
| Session cookie | `session` cookie, `HttpOnly` | 24 hours | `/ui/*` routes (except static + login) |
| API proxy | Server-side token injection | Per-request | `/ui/api/*` → internal API |
