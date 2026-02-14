import { Hono } from "hono";
import { ReportsStore, ValidationError, NotFoundError, type ReportFilters } from "./store.js";
import { ShareStore } from "./share-store.js";
import { createShareAdminRoutes, createSharePublicRoutes } from "./share-routes.js";
import { emit } from "../events/emit.js";

const reportsStore = new ReportsStore();
const shareStore = new ShareStore();

export const reportsRoutes = new Hono();

// Create a report
reportsRoutes.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const report = reportsStore.create(body);
    emit('reports', 'reports.report.created', { reportId: report.id, title: report.title, author: report.author, tags: report.tags }, report.author);
    return c.json(report, 201);
  } catch (e) {
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// List reports with optional filters and pagination
reportsRoutes.get("/", (c) => {
  const filters: ReportFilters = {};
  const author = c.req.query("author");
  const tag = c.req.query("tag");

  if (author) filters.author = author;
  if (tag) filters.tag = tag;

  const allReports = reportsStore.list(filters);
  const total = allReports.length;

  // Pagination: ?limit=50&offset=0 (default: 50 most recent)
  const limit = Math.min(parseInt(c.req.query("limit") || "50", 10) || 50, 200);
  const offset = parseInt(c.req.query("offset") || "0", 10) || 0;

  // Sort newest first, then paginate
  const sorted = allReports.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const page = sorted.slice(offset, offset + limit);

  // Return reports without content for listing (lighter payload)
  const summaries = page.map(({ content, ...rest }) => rest);
  return c.json({ reports: summaries, count: summaries.length, total, limit, offset });
});

// Get a single report
reportsRoutes.get("/:id", (c) => {
  const report = reportsStore.get(c.req.param("id"));
  if (!report) return c.json({ error: "report not found" }, 404);
  return c.json(report);
});

// Update a report (partial)
reportsRoutes.patch("/:id", async (c) => {
  try {
    const body = await c.req.json();
    const report = reportsStore.update(c.req.param("id"), body);
    return c.json(report);
  } catch (e) {
    if (e instanceof NotFoundError) return c.json({ error: e.message }, 404);
    if (e instanceof ValidationError) return c.json({ error: e.message }, 400);
    throw e;
  }
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
