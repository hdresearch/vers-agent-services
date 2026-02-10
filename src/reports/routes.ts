import { Hono } from "hono";
import { ReportsStore, ValidationError, type ReportFilters } from "./store.js";
import { ShareStore } from "./share-store.js";
import { createShareAdminRoutes, createSharePublicRoutes } from "./share-routes.js";

const reportsStore = new ReportsStore();
const shareStore = new ShareStore();

export const reportsRoutes = new Hono();

// Create a report
reportsRoutes.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const report = reportsStore.create(body);
    return c.json(report, 201);
  } catch (e) {
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// List reports with optional filters
reportsRoutes.get("/", (c) => {
  const filters: ReportFilters = {};
  const author = c.req.query("author");
  const tag = c.req.query("tag");

  if (author) filters.author = author;
  if (tag) filters.tag = tag;

  const reports = reportsStore.list(filters);
  // Return reports without content for listing (lighter payload)
  const summaries = reports.map(({ content, ...rest }) => rest);
  return c.json({ reports: summaries, count: summaries.length });
});

// Get a single report
reportsRoutes.get("/:id", (c) => {
  const report = reportsStore.get(c.req.param("id"));
  if (!report) return c.json({ error: "report not found" }, 404);
  return c.json(report);
});

// Delete a report
reportsRoutes.delete("/:id", (c) => {
  const deleted = reportsStore.delete(c.req.param("id"));
  if (!deleted) return c.json({ error: "report not found" }, 404);
  return c.json({ deleted: true });
});

// Mount share admin routes (these are under /reports/ which already has auth)
const shareAdminRoutes = createShareAdminRoutes(shareStore, reportsStore);
reportsRoutes.route("/", shareAdminRoutes);

// Export public share routes (mounted separately in server.ts, no auth)
export const sharePublicRoutes = createSharePublicRoutes(shareStore, reportsStore);
