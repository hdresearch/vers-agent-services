import { Hono } from "hono";
import { ApiKeyStore } from "./keys.js";

let _store: ApiKeyStore | null = null;

/** Get or create the singleton store. Accepts optional path for testing. */
export function getKeyStore(dbPath?: string): ApiKeyStore {
  if (!_store) {
    _store = new ApiKeyStore(dbPath);
  }
  return _store;
}

/** Replace the singleton (for testing). */
export function setKeyStore(store: ApiKeyStore): void {
  _store = store;
}

export const keyRoutes = new Hono();

// POST /auth/keys — create a new API key (returns raw key once)
keyRoutes.post("/keys", async (c) => {
  const body = await c.req.json<{ name?: string; scopes?: string[] }>();

  if (!body.name || typeof body.name !== "string" || body.name.trim() === "") {
    return c.json({ error: "name is required" }, 400);
  }

  if (body.scopes !== undefined) {
    if (!Array.isArray(body.scopes) || !body.scopes.every((s) => typeof s === "string")) {
      return c.json({ error: "scopes must be an array of strings" }, 400);
    }
  }

  const store = getKeyStore();
  const result = store.create({ name: body.name.trim(), scopes: body.scopes });

  return c.json(
    {
      key: result.key,
      rawKey: result.rawKey,
      warning: "Store this key securely — it will not be shown again.",
    },
    201
  );
});

// GET /auth/keys — list all API keys (no raw keys)
keyRoutes.get("/keys", (c) => {
  const store = getKeyStore();
  const keys = store.list();
  return c.json({ keys });
});

// DELETE /auth/keys/:id — revoke an API key
keyRoutes.delete("/keys/:id", (c) => {
  const id = c.req.param("id");
  const store = getKeyStore();
  const revoked = store.revoke(id);

  if (!revoked) {
    return c.json({ error: "Key not found or already revoked" }, 404);
  }

  return c.json({ revoked: true, id });
});
