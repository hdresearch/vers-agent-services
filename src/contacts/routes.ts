import { Hono } from "hono";
import { ContactsStore, fetchGitHubKeys } from "./store.js";
import type { CreateContactInput, UpdateContactInput, PeerAcceptInput, TrustLevel } from "./store.js";
import { ValidationError, NotFoundError } from "../errors.js";
import { emit } from "../events/emit.js";
import { fleetChatStore } from "../fleet-chat/routes.js";
import { bearerAuth } from "../auth.js";

// ── Store singleton ────────────────────────────────────────────────────────

export const contactsStore = new ContactsStore();

// ── Helper: sync trusted contact to fleet-chat ─────────────────────────────

function syncTrustedToFleetChat(contact: { commonName: string; fleetName: string | null; endpoint: string | null; publicKey: string | null }): void {
  if (!contact.endpoint || !contact.publicKey) return;
  try {
    fleetChatStore.addTrustedEndpoint({
      name: contact.fleetName || contact.commonName,
      endpoint: contact.endpoint,
      publicKey: contact.publicKey,
    });
  } catch (err) {
    console.error("[contacts] Failed to sync trusted endpoint to fleet-chat:", err);
  }
}

// ── Authenticated routes ───────────────────────────────────────────────────

export const contactsRoutes = new Hono();

// Auth for /:id routes (ULID-based contact operations)
contactsRoutes.use("/:id{[0-9A-Z]{26}}", bearerAuth());

// GET /contacts — list all contacts
contactsRoutes.get("/", (c) => {
  const trustLevel = c.req.query("trustLevel") as TrustLevel | undefined;
  const search = c.req.query("search") || undefined;
  const contacts = contactsStore.list({ trustLevel, search });
  return c.json({ contacts, count: contacts.length });
});

// POST /contacts — create a contact
contactsRoutes.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const input = body as CreateContactInput;

    // If githubUsername provided and no publicKey, auto-fetch
    if (input.githubUsername && !input.publicKey) {
      const keyResult = await fetchGitHubKeys(input.githubUsername);
      if (keyResult) {
        input.publicKey = keyResult.key;
      }
    }

    const contact = contactsStore.create(input);

    // Auto-sync to fleet-chat if trusted
    if (contact.trustLevel === "trusted") {
      syncTrustedToFleetChat(contact);
    }

    emit("contacts", "contacts.created", {
      contactId: contact.id,
      commonName: contact.commonName,
      trustLevel: contact.trustLevel,
      githubUsername: contact.githubUsername,
    });
    return c.json(contact, 201);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

// GET /contacts/:id — get one contact
contactsRoutes.get("/:id", (c) => {
  try {
    const contact = contactsStore.get(c.req.param("id"));
    return c.json(contact);
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// PUT /contacts/:id — update a contact
contactsRoutes.put("/:id", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const input = body as UpdateContactInput;
    const oldContact = contactsStore.get(c.req.param("id"));
    const contact = contactsStore.update(c.req.param("id"), input);

    // If trust level changed to "trusted", sync to fleet-chat
    if (contact.trustLevel === "trusted" && oldContact.trustLevel !== "trusted") {
      syncTrustedToFleetChat(contact);
    }

    emit("contacts", "contacts.updated", {
      contactId: contact.id,
      commonName: contact.commonName,
      trustLevel: contact.trustLevel,
    });
    return c.json(contact);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// DELETE /contacts/:id — remove a contact
contactsRoutes.delete("/:id", (c) => {
  try {
    const contact = contactsStore.get(c.req.param("id"));
    contactsStore.delete(c.req.param("id"));
    emit("contacts", "contacts.deleted", {
      contactId: contact.id,
      commonName: contact.commonName,
    });
    return c.json({ deleted: true });
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// POST /contacts/from-github/:username — create contact from GitHub username
contactsRoutes.post("/from-github/:username", async (c) => {
  const username = c.req.param("username");

  try {
    // Check if contact with this github username already exists
    const existing = contactsStore.findByGithubUsername(username);
    if (existing) {
      return c.json({ error: `Contact already exists for GitHub user ${username}`, contact: existing }, 409);
    }

    const keyResult = await fetchGitHubKeys(username);
    if (!keyResult) {
      return c.json({ error: `Could not fetch keys for GitHub user ${username}` }, 404);
    }

    const contact = contactsStore.create({
      commonName: username,
      githubUsername: username,
      publicKey: keyResult.key,
      trustLevel: "known",
      metadata: { keyType: keyResult.type, source: "github" },
    });

    emit("contacts", "contacts.created-from-github", {
      contactId: contact.id,
      githubUsername: username,
      keyType: keyResult.type,
    });
    return c.json(contact, 201);
  } catch (err) {
    if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
    throw err;
  }
});

// POST /contacts/refresh-keys/:id — re-fetch keys from GitHub
contactsRoutes.post("/refresh-keys/:id", async (c) => {
  try {
    const contact = contactsStore.get(c.req.param("id"));
    if (!contact.githubUsername) {
      return c.json({ error: "Contact has no GitHub username" }, 400);
    }

    const keyResult = await fetchGitHubKeys(contact.githubUsername);
    if (!keyResult) {
      return c.json({ error: `Could not fetch keys for GitHub user ${contact.githubUsername}` }, 502);
    }

    const oldKey = contact.publicKey;
    const updated = contactsStore.update(contact.id, {
      publicKey: keyResult.key,
      metadata: { ...contact.metadata, keyType: keyResult.type, lastKeyRefresh: new Date().toISOString() },
    });

    const keyChanged = oldKey !== keyResult.key;
    emit("contacts", "contacts.keys-refreshed", {
      contactId: contact.id,
      githubUsername: contact.githubUsername,
      keyChanged,
    });

    return c.json({ contact: updated, keyChanged, keyType: keyResult.type });
  } catch (err) {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// ── Peering invite routes (auth required) ──────────────────────────────────

// POST /contacts/peer/invite — generate a peering invite link
contactsRoutes.post("/peer/invite", async (c) => {
  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json();
  } catch {
    // no body is fine
  }

  // Get our identity from fleet-chat
  const identity = fleetChatStore.getLocalIdentity();
  if (!identity) {
    return c.json({ error: "Local fleet identity not set. Set via POST /fleet-chat/identity first." }, 400);
  }

  const invite = contactsStore.createPeerInvite({
    label: body.label as string | undefined,
    expiresInHours: body.expiresInHours as number | undefined,
  });

  // Build the accept URL
  const endpoint = identity.endpoint.replace(/\/$/, "");
  const url = `${endpoint}/contacts/peer/accept?token=${invite.token}`;

  emit("contacts", "contacts.peer.invite-created", {
    inviteId: invite.id,
    label: invite.label,
    expiresAt: invite.expiresAt,
  });

  return c.json({
    invite,
    url,
    instructions: `Send this URL to your peer. They visit it with their identity to establish mutual trust.`,
    curl: `curl -sk "${url}" -X POST -H "Content-Type: application/json" -d '{"name":"THEIR_NAME","endpoint":"THEIR_ENDPOINT","publicKey":"THEIR_KEY"}'`,
  }, 201);
});

// GET /contacts/peer/invites — list peering invites
contactsRoutes.get("/peer/invites", (c) => {
  const status = c.req.query("status") || undefined;
  const invites = contactsStore.listPeerInvites(status);
  return c.json({ invites, count: invites.length });
});

// ── Public peering routes (NO auth) ────────────────────────────────────────

export const contactsPublicRoutes = new Hono();

// GET /contacts/peer/accept?token=XXX — show our identity (for browser visits)
contactsPublicRoutes.get("/peer/accept", (c) => {
  const token = c.req.query("token");
  if (!token) return c.json({ error: "token query parameter required" }, 400);

  const invite = contactsStore.validatePeerInvite(token);
  if (!invite) {
    return c.json({ error: "Invalid, expired, or already redeemed invite" }, 404);
  }

  const identity = fleetChatStore.getLocalIdentity();
  if (!identity) {
    return c.json({ error: "Fleet identity not configured" }, 500);
  }

  return c.json({
    message: "Peering invite valid. POST your identity to this endpoint to complete peering.",
    ourIdentity: identity,
    acceptEndpoint: c.req.url.split("?")[0],
    token,
    example: {
      method: "POST",
      body: { name: "your-fleet-name", endpoint: "https://your-endpoint:3000", publicKey: "your-public-key" },
    },
  });
});

// POST /contacts/peer/accept — complete peering handshake (PUBLIC)
contactsPublicRoutes.post("/peer/accept", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Token can be in query or body
  const token = c.req.query("token") || (body as any)?.token;
  if (!token) return c.json({ error: "token is required (query param or body)" }, 400);

  const invite = contactsStore.validatePeerInvite(token);
  if (!invite) {
    return c.json({ error: "Invalid, expired, or already redeemed invite" }, 404);
  }

  const input = body as PeerAcceptInput;
  if (!input.name?.trim()) return c.json({ error: "name is required" }, 400);
  if (!input.endpoint?.trim()) return c.json({ error: "endpoint is required" }, 400);
  if (!input.publicKey?.trim()) return c.json({ error: "publicKey is required" }, 400);

  // Create contact for the peer on OUR side
  const contact = contactsStore.create({
    commonName: input.name.trim(),
    fleetName: input.fleetName || input.name.trim(),
    endpoint: input.endpoint.trim(),
    publicKey: input.publicKey.trim(),
    githubUsername: input.githubUsername,
    trustLevel: "trusted",
  });

  // Sync to fleet-chat trusted endpoints
  syncTrustedToFleetChat(contact);

  // Mark invite as redeemed
  contactsStore.redeemPeerInvite(token, contact.id, input.name.trim());

  // Get our identity to return
  const identity = fleetChatStore.getLocalIdentity();
  if (!identity) {
    return c.json({ error: "Fleet identity not configured" }, 500);
  }

  // Auto-create fleet-chat channel
  let channelId: string | null = null;
  try {
    const channel = fleetChatStore.createChannel({
      remoteFleet: {
        name: contact.fleetName || contact.commonName,
        endpoint: contact.endpoint!,
        publicKey: contact.publicKey!,
      },
    });
    channelId = channel.id;

    // Send handshake message
    fleetChatStore.sendMessage({
      channelId: channel.id,
      content: `👋 Peering established! Fleet "${identity.name}" is now connected with "${contact.commonName}".`,
      type: "system",
    });
  } catch (err) {
    console.error("[contacts] Failed to create channel after peering:", err);
  }

  emit("contacts", "contacts.peer.completed", {
    contactId: contact.id,
    peerName: contact.commonName,
    channelId,
  });

  return c.json({
    peered: true,
    contact: {
      name: contact.commonName,
      id: contact.id,
    },
    ourIdentity: identity,
    channelId,
    message: `Peering complete! You are now trusted by fleet "${identity.name}". Add us to your trusted endpoints to complete bidirectional trust.`,
    addUsAs: {
      name: identity.name,
      endpoint: identity.endpoint,
      publicKey: identity.publicKey,
    },
  }, 200);
});
