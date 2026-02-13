---
name: magic-link
description: Generate a magic login link for the agent-services dashboard UI. Use when the user wants to access the dashboard, needs a login link, says "magic link," or asks for UI access.
---

# Magic Link

Generate a one-time login URL for the agent-services browser dashboard. The link grants a 24-hour session without exposing the bearer token to the browser.

## When to Use

- User asks for a "magic link" or "login link"
- User wants to access the dashboard / UI
- User wants to check the board, feed, or reports in a browser

## Steps

### 1. Find the infra VM

Look up the infra VM address from the registry:

```
registry_list(role: "infra")
```

The main agent-services VM is the one with `board`, `feed`, `registry` services (not the gitea-forge).

### 2. Generate the magic link

```bash
curl -s -X POST "https://<INFRA_VM_ADDRESS>:3000/auth/magic-link" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" | jq .
```

Response:

```json
{
  "url": "https://<host>:3000/ui/login?token=<one-time-token>",
  "expiresAt": "2026-02-12T18:19:27.000Z"
}
```

### 3. Share the URL

Give the user the `url` from the response. Note:

- **Expires in 5 minutes** — if they don't click in time, generate a new one
- **One-time use** — the token is consumed on first click
- **Session lasts 24 hours** — after that they'll need a new link

## Details

- The magic link flow is documented in full at `docs/auth.md` in the vers-agent-services repo
- The bearer token is never exposed to the browser — the server proxies API requests and injects it server-side
- Unauthenticated endpoints (no link needed): `GET /health`, `/ui/static/*`, `GET /reports/shared/:shareId`
