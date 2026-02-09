import { Hono } from "hono";
import {
  RegistryStore,
  NotFoundError,
  ValidationError,
  ConflictError,
  type VMFilters,
  type VMRole,
  type VMStatus,
} from "./store.js";

export const registryStore = new RegistryStore();

export const registryRoutes = new Hono();

// Register a VM
registryRoutes.post("/vms", async (c) => {
  try {
    const body = await c.req.json();
    const vm = registryStore.register(body);
    return c.json(vm, 201);
  } catch (e) {
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    if (e instanceof ConflictError) return c.json({ error: e.message }, 409);
    throw e;
  }
});

// List all registered VMs
registryRoutes.get("/vms", (c) => {
  const filters: VMFilters = {};
  const role = c.req.query("role");
  const status = c.req.query("status");

  if (role) filters.role = role as VMRole;
  if (status) filters.status = status as VMStatus;

  const vms = registryStore.list(filters);
  return c.json({ vms, count: vms.length });
});

// Get a single VM
registryRoutes.get("/vms/:id", (c) => {
  const vm = registryStore.get(c.req.param("id"));
  if (!vm) return c.json({ error: "VM not found" }, 404);
  return c.json(vm);
});

// Update a VM
registryRoutes.patch("/vms/:id", async (c) => {
  try {
    const body = await c.req.json();
    const vm = registryStore.update(c.req.param("id"), body);
    return c.json(vm);
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// Deregister a VM
registryRoutes.delete("/vms/:id", (c) => {
  const deleted = registryStore.deregister(c.req.param("id"));
  if (!deleted) return c.json({ error: "VM not found" }, 404);
  return c.json({ deleted: true });
});

// Heartbeat
registryRoutes.post("/vms/:id/heartbeat", (c) => {
  try {
    const vm = registryStore.heartbeat(c.req.param("id"));
    return c.json({ id: vm.id, lastSeen: vm.lastSeen });
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    throw e;
  }
});

// Discover VMs by role
registryRoutes.get("/discover/:role", (c) => {
  const role = c.req.param("role") as VMRole;
  const vms = registryStore.discover(role);
  return c.json({ vms, count: vms.length });
});
