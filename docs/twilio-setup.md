# Twilio SMS Integration

The Twilio integration lets you interact with the agent fleet via SMS. Text commands to create tasks, journal entries, and log entries. The fleet can also text you back with notifications.

## Architecture

```
Your Phone ←→ Twilio ←→ /twilio/webhook (inbound SMS)
Fleet agents → /twilio/send (outbound SMS)
Fleet agents → /twilio/notify (notifications to your phone)
```

## 1. Create a Twilio Account

1. Sign up at [twilio.com](https://www.twilio.com)
2. Buy a phone number with SMS capability (~$1.15/month)
3. Note your **Account SID** and **Auth Token** from the console dashboard

## 2. Set Environment Variables

On the infra VM, add these to the environment (e.g. in `.env` or systemd unit):

```bash
# Required for all Twilio features
TWILIO_ACCOUNT_SID=AC...          # From Twilio console
TWILIO_AUTH_TOKEN=...              # From Twilio console
TWILIO_PHONE_NUMBER=+15551234567  # Your Twilio phone number (E.164 format)

# Required for inbound SMS (webhook validation)
# TWILIO_AUTH_TOKEN is used for signature validation (already set above)

# Required for /twilio/notify endpoint
TWILIO_NOTIFY_NUMBER=+15559876543 # Your personal phone number (where to send notifications)

# Optional
TWILIO_WEBHOOK_URL=https://<infra-vm>.vm.vers.sh:3000/twilio/webhook  # Override webhook URL for signature validation
TWILIO_ALLOWED_NUMBERS=+15559876543,+15551111111  # Comma-separated allowlist (if unset, any number can text in)
```

## 3. Configure Twilio Webhook

In the Twilio console:

1. Go to **Phone Numbers** → click your number
2. Under **Messaging** → **A message comes in**:
   - Webhook: `https://<infra-vm-id>.vm.vers.sh:3000/twilio/webhook`
   - HTTP POST
3. Save

> **Important**: Set `TWILIO_WEBHOOK_URL` to the exact URL you configure in Twilio. The signature validation compares against this URL. If you don't set it, the server uses the request URL, which may differ from what Twilio signed.

## 4. Inbound SMS — Commands

Text your Twilio number with these prefixes:

| Prefix | Action | Example |
|--------|--------|---------|
| *(no prefix)* | Create journal entry | `Feeling productive today` |
| `j:` or `journal:` | Create journal entry | `j: morning reflection` |
| `t:` or `task:` | Create board task | `t: fix the login page` |
| `l:` or `log:` | Create log entry | `l: deployed v2.1` |

You'll get a TwiML reply confirming the action.

## 5. Outbound SMS — Send from Fleet

Authenticated endpoint (requires bearer token):

```bash
INFRA="https://<infra-vm-id>.vm.vers.sh:3000"
AUTH="Authorization: Bearer <your-token>"

curl -s -X POST "$INFRA/twilio/send" \
  -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{"to": "+15559876543", "body": "hello from the hive"}'
```

Response:
```json
{"ok": true, "sid": "SM..."}
```

## 6. Notifications — Alert Noah

Authenticated endpoint for fleet-to-operator notifications:

```bash
curl -s -X POST "$INFRA/twilio/notify" \
  -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{"message": "Task completed: fix the build", "urgency": "normal"}'
```

Urgency levels:
- `high` — 🚨 prefix, for critical alerts (zombie VMs, failures)
- `normal` — 📌 prefix, for task completions, review requests
- `low` — 📋 prefix, for daily summaries, batch updates

## 7. Status Check

Check Twilio configuration status (no auth required):

```bash
curl -s "$INFRA/twilio/status" | jq
```

Response:
```json
{
  "configured": true,
  "inbound": true,
  "outbound": true,
  "notify": true,
  "missing": []
}
```

## 8. Testing

### Check status
```bash
curl -s "$INFRA/twilio/status" | jq
```

### Test inbound (text your Twilio number)
```
log: test message from phone
```

### Test outbound
```bash
curl -s -X POST "$INFRA/twilio/send" \
  -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{"to": "+15559876543", "body": "hello from the hive"}'
```

### Test notify
```bash
curl -s -X POST "$INFRA/twilio/notify" \
  -H "$AUTH" \
  -H "Content-Type: application/json" \
  -d '{"message": "Test notification", "urgency": "low"}'
```

### Run unit tests
```bash
cd /root/vers-agent-services
bun test src/twilio
```

## Use Cases

- **Agent completes a task** → `POST /twilio/notify` with `urgency: "normal"`
- **Review queue has items** → `POST /twilio/notify` with `urgency: "normal"`
- **Zombie VM detected** → `POST /twilio/notify` with `urgency: "high"`
- **Daily summary** → `POST /twilio/notify` with `urgency: "low"`
- **Deploy confirmation** → `POST /twilio/send` to specific number
- **Ad-hoc from phone** → text `t: investigate memory leak` to create a task

## Endpoints Summary

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/twilio/status` | None | Check configuration status |
| POST | `/twilio/webhook` | Twilio signature | Inbound SMS from Twilio |
| POST | `/twilio/send` | Bearer token | Send SMS to any number |
| POST | `/twilio/notify` | Bearer token | Send notification to Noah |
