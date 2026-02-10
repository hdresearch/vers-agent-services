---
name: reports
description: Create, view, and share agent reports. Use when publishing structured findings, generating share links for stakeholders, or tracking who accessed a shared report.
---

# Reports

Structured reports that agents produce as deliverables — investigation summaries, sprint recaps, architecture reviews, cost analyses. Reports are private by default (bearer auth required). Admins can generate share links for read-only public access to individual reports.

## When to Use

- **Publishing a deliverable** — after completing a task, write a report with findings, not just a board note
- **Sharing with stakeholders** — generate a share link so someone without API credentials can read a report
- **Tracking report access** — see who viewed a shared report, when, and from where
- **Revoking access** — disable a share link without deleting the report or its access history

## Reports vs. Logs vs. Board Notes

| Use this | When you want to |
|----------|-----------------|
| **Report** | Publish a structured, standalone document (markdown) — meant to be read by humans |
| **Board note** | Add context to a task — findings, blockers, status updates during work |
| **Feed event** | Signal that something happened — short, machine-readable, for coordination |
| **Log** | Append raw operational data — stdout, stderr, debug traces |

**Rule of thumb:** If it has a title and you'd want to share it with someone, it's a report. If it's a status update on a task, it's a board note.

## Convention

`VERS_INFRA_URL` env var points to the infra VM (e.g., `http://abc123.vm.vers.sh:3000`). All endpoints require `Authorization: Bearer $VERS_AUTH_TOKEN` unless noted otherwise.

## API Reference — Reports

### Create a Report

```bash
curl -X POST "$VERS_INFRA_URL/reports" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Auth Middleware Investigation",
    "author": "backend-lt",
    "content": "# Summary\n\nFound three issues with the current auth middleware...\n\n## Findings\n\n1. Token expiry not checked\n2. Missing CORS preflight handling\n3. No rate limiting on login endpoint",
    "tags": ["auth", "security", "investigation"]
  }'
```

Returns `201`. Required: `title`, `author`, `content`. Optional: `tags` (string array, default `[]`).

The `content` field supports markdown — headings, code blocks, tables, lists, links, images.

### List Reports

```bash
# All reports (returns summaries without content)
curl "$VERS_INFRA_URL/reports" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"

# Filter by author
curl "$VERS_INFRA_URL/reports?author=backend-lt" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"

# Filter by tag
curl "$VERS_INFRA_URL/reports?tag=security" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"
```

Returns `{ reports: [...], count: N }`. Sorted newest first. Listing omits `content` for lighter payloads.

### Get a Single Report

```bash
curl "$VERS_INFRA_URL/reports/$REPORT_ID" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"
```

Returns the full report including `content`.

### Delete a Report

```bash
curl -X DELETE "$VERS_INFRA_URL/reports/$REPORT_ID" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"
```

## API Reference — Share Links

Share links give read-only public access to a single report. No authentication required to view. Access is logged.

### Create a Share Link

```bash
curl -X POST "$VERS_INFRA_URL/reports/$REPORT_ID/share" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "createdBy": "orchestrator",
    "label": "shared with platform team",
    "expiresAt": "2026-03-01T00:00:00Z"
  }'
```

Returns `201` with `{ linkId, url }`. The `url` is a full URL (e.g., `https://host/reports/share/01ABC...`) that anyone can open in a browser.

Optional fields:
- `createdBy` — who created the link (default: `"admin"`)
- `label` — human-readable note about why/who the link is for
- `expiresAt` — ISO timestamp after which the link stops working (omit for no expiry)

### List Share Links for a Report

```bash
curl "$VERS_INFRA_URL/reports/$REPORT_ID/shares" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"
```

Returns `{ links: [...], count: N }`. Each link includes an `accessCount` showing how many times it's been visited.

### Revoke a Share Link

```bash
curl -X DELETE "$VERS_INFRA_URL/reports/share/$LINK_ID" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"
```

Sets `revoked=1` on the link. The link remains in the database for audit purposes but returns a 404 error page to visitors. Returns `400` if the link is already revoked.

### View Access Log

```bash
curl "$VERS_INFRA_URL/reports/share/$LINK_ID/access" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"
```

Returns `{ log: [...], count: N }`. Each entry has: `timestamp`, `ip`, `userAgent`, `referrer`.

### Access a Shared Report (Public — No Auth)

```
GET /reports/share/$LINK_ID
```

No `Authorization` header needed. Opens in a browser and renders the report using the built-in viewer. If the link is invalid, revoked, or expired, returns a 404 error page.

Every visit is recorded in the access log with IP, user agent, and referrer.

## Common Patterns

### Agent Publishes a Report After Completing a Task

```bash
# 1. Create the report
REPORT=$(curl -s -X POST "$VERS_INFRA_URL/reports" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Sprint 12 Cost Analysis",
    "author": "cost-lt",
    "content": "# Cost Summary\n\n| Service | Cost | Delta |\n|---------|------|-------|\n| Compute | $142 | +12% |\n| Storage | $38 | -3% |\n\n## Recommendations\n\n1. Right-size the staging VMs\n2. Enable auto-pause on idle workers",
    "tags": ["cost", "sprint-12"]
  }')
REPORT_ID=$(echo "$REPORT" | jq -r '.id')

# 2. Note it on the board task
curl -X POST "$VERS_INFRA_URL/board/tasks/$TASK_ID/notes" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"author\": \"cost-lt\",
    \"content\": \"Report published: $REPORT_ID\",
    \"type\": \"update\"
  }"
```

### Generate and Distribute a Share Link

```bash
# Create a share link with an expiry
SHARE=$(curl -s -X POST "$VERS_INFRA_URL/reports/$REPORT_ID/share" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "createdBy": "orchestrator",
    "label": "for Monday standup",
    "expiresAt": "2026-02-17T00:00:00Z"
  }')
SHARE_URL=$(echo "$SHARE" | jq -r '.url')
echo "Share this link: $SHARE_URL"
```

### Check Who Viewed a Shared Report

```bash
# List all links for a report
LINKS=$(curl -s "$VERS_INFRA_URL/reports/$REPORT_ID/shares" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN")
echo "$LINKS" | jq '.links[] | {linkId, label, accessCount, revoked}'

# Get detailed access log for a specific link
LINK_ID=$(echo "$LINKS" | jq -r '.links[0].linkId')
curl -s "$VERS_INFRA_URL/reports/share/$LINK_ID/access" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  | jq '.log[] | {timestamp, ip, userAgent}'
```

### Revoke Access After a Meeting

```bash
# Revoke the share link — visitors now see a 404
curl -X DELETE "$VERS_INFRA_URL/reports/share/$LINK_ID" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN"

# The access log is preserved even after revocation
curl -s "$VERS_INFRA_URL/reports/share/$LINK_ID/access" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  | jq '.count'
```

### Create a Permanent (No-Expiry) Share Link

```bash
# Omit expiresAt — link stays valid until explicitly revoked
curl -X POST "$VERS_INFRA_URL/reports/$REPORT_ID/share" \
  -H "Authorization: Bearer $VERS_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"createdBy": "orchestrator", "label": "permanent docs link"}'
```

## Storage

- **Reports** are stored in `data/reports.json` (JSON file)
- **Share links and access logs** are stored in `data/reports.db` (SQLite, better-sqlite3)
- The SQLite database has two tables: `share_links` and `share_access_log`
- Revocation is a soft delete (`revoked=1`) — the link row and its access log are preserved

## Schemas

```typescript
interface Report {
  id: string;              // ULID
  title: string;
  author: string;
  content: string;         // Markdown
  tags: string[];
  createdAt: string;       // ISO timestamp
  updatedAt: string;
}

interface ShareLink {
  linkId: string;          // ULID — used in the URL
  reportId: string;        // Report this link points to
  createdAt: string;
  createdBy: string;
  expiresAt: string | null;
  label: string | null;
  revoked: number;         // 0 = active, 1 = revoked
}

interface ShareLinkWithCount extends ShareLink {
  accessCount: number;     // Number of times the link was visited
}

interface AccessLogEntry {
  id: string;              // ULID
  linkId: string;
  reportId: string;
  timestamp: string;
  ip: string | null;
  userAgent: string | null;
  referrer: string | null;
}
```
