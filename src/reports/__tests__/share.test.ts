import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ShareStore } from "../share-store.js";
import { ReportsStore } from "../store.js";
import { createShareAdminRoutes, createSharePublicRoutes } from "../share-routes.js";

describe("ShareStore", () => {
  let store: ShareStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "share-test-"));
    store = new ShareStore(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a share link", () => {
    const link = store.createLink({
      reportId: "RPT1",
      createdBy: "admin",
    });
    expect(link.linkId).toBeTruthy();
    expect(link.reportId).toBe("RPT1");
    expect(link.createdBy).toBe("admin");
    expect(link.revoked).toBe(0);
    expect(link.expiresAt).toBeNull();
  });

  it("creates a link with expiry and label", () => {
    const link = store.createLink({
      reportId: "RPT1",
      createdBy: "admin",
      expiresAt: "2099-01-01T00:00:00Z",
      label: "for team",
    });
    expect(link.expiresAt).toBe("2099-01-01T00:00:00Z");
    expect(link.label).toBe("for team");
  });

  it("gets a link by id", () => {
    const created = store.createLink({ reportId: "RPT1", createdBy: "admin" });
    const fetched = store.getLink(created.linkId);
    expect(fetched).toBeDefined();
    expect(fetched!.linkId).toBe(created.linkId);
  });

  it("returns undefined for unknown link", () => {
    expect(store.getLink("NOPE")).toBeUndefined();
  });

  it("lists links for a report with access counts", () => {
    const link1 = store.createLink({ reportId: "RPT1", createdBy: "admin" });
    const link2 = store.createLink({ reportId: "RPT1", createdBy: "admin" });
    store.createLink({ reportId: "RPT2", createdBy: "admin" });

    // Add some access to link1
    store.recordAccess(link1.linkId, "RPT1", { ip: "1.2.3.4" });
    store.recordAccess(link1.linkId, "RPT1", { ip: "5.6.7.8" });

    const links = store.listLinksForReport("RPT1");
    expect(links).toHaveLength(2);

    const l1 = links.find((l) => l.linkId === link1.linkId)!;
    const l2 = links.find((l) => l.linkId === link2.linkId)!;
    expect(l1.accessCount).toBe(2);
    expect(l2.accessCount).toBe(0);
  });

  it("revokes a link", () => {
    const link = store.createLink({ reportId: "RPT1", createdBy: "admin" });
    expect(store.revokeLink(link.linkId)).toBe(true);

    const fetched = store.getLink(link.linkId);
    expect(fetched!.revoked).toBe(1);
  });

  it("revoking already-revoked link returns false", () => {
    const link = store.createLink({ reportId: "RPT1", createdBy: "admin" });
    store.revokeLink(link.linkId);
    expect(store.revokeLink(link.linkId)).toBe(false);
  });

  it("validates a valid link", () => {
    const link = store.createLink({ reportId: "RPT1", createdBy: "admin" });
    expect(store.validateLink(link.linkId)).toBeTruthy();
  });

  it("validates returns null for revoked link", () => {
    const link = store.createLink({ reportId: "RPT1", createdBy: "admin" });
    store.revokeLink(link.linkId);
    expect(store.validateLink(link.linkId)).toBeNull();
  });

  it("validates returns null for expired link", () => {
    const link = store.createLink({
      reportId: "RPT1",
      createdBy: "admin",
      expiresAt: "2020-01-01T00:00:00Z",
    });
    expect(store.validateLink(link.linkId)).toBeNull();
  });

  it("validates returns null for unknown link", () => {
    expect(store.validateLink("NOPE")).toBeNull();
  });

  it("records and retrieves access log", () => {
    const link = store.createLink({ reportId: "RPT1", createdBy: "admin" });
    store.recordAccess(link.linkId, "RPT1", {
      ip: "1.2.3.4",
      userAgent: "TestBot/1.0",
      referrer: "https://example.com",
    });
    store.recordAccess(link.linkId, "RPT1", { ip: "5.6.7.8" });

    const log = store.getAccessLog(link.linkId);
    expect(log).toHaveLength(2);
    // Newest first (by timestamp DESC)
    const ips = log.map((e) => e.ip);
    expect(ips).toContain("1.2.3.4");
    expect(ips).toContain("5.6.7.8");
    const detailed = log.find((e) => e.ip === "1.2.3.4")!;
    expect(detailed.userAgent).toBe("TestBot/1.0");
    expect(detailed.referrer).toBe("https://example.com");
  });
});

describe("Share API routes", () => {
  let app: Hono;
  let tmpDir: string;
  let shareStore: ShareStore;
  let reportsStore: ReportsStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "share-route-test-"));
    reportsStore = new ReportsStore(join(tmpDir, "reports.json"));
    shareStore = new ShareStore(join(tmpDir, "share.db"));

    app = new Hono();

    // Mount public routes first (no auth), then admin routes
    const publicRoutes = createSharePublicRoutes(shareStore, reportsStore);
    app.route("/reports", publicRoutes);

    const adminRoutes = createShareAdminRoutes(shareStore, reportsStore);
    app.route("/reports", adminRoutes);
  });

  afterEach(() => {
    shareStore.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createReport(title = "Test Report") {
    return reportsStore.create({
      title,
      author: "agent",
      content: "# Hello\nThis is a test report.",
    });
  }

  it("POST /reports/:id/share creates a share link", async () => {
    const report = createReport();
    const res = await app.request(`/reports/${report.id}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "for team" }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.linkId).toBeTruthy();
    expect(data.url).toContain(`/reports/share/${data.linkId}`);
  });

  it("POST /reports/:id/share returns 404 for unknown report", async () => {
    const res = await app.request("/reports/NOPE/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("GET /reports/:id/shares lists share links with access counts", async () => {
    const report = createReport();

    // Create two links
    await app.request(`/reports/${report.id}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    await app.request(`/reports/${report.id}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "second" }),
    });

    const res = await app.request(`/reports/${report.id}/shares`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.count).toBe(2);
    expect(data.links[0].accessCount).toBeDefined();
  });

  it("GET /reports/share/:linkId renders the report (public access)", async () => {
    const report = createReport();
    const createRes = await app.request(`/reports/${report.id}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { linkId } = await createRes.json();

    const res = await app.request(`/reports/share/${linkId}`, {
      headers: { "User-Agent": "TestBot/1.0", Referer: "https://example.com" },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Test Report");
    expect(html).toContain("report-viewer");
  });

  it("GET /reports/share/:linkId records access", async () => {
    const report = createReport();
    const createRes = await app.request(`/reports/${report.id}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { linkId } = await createRes.json();

    // Visit the link
    await app.request(`/reports/share/${linkId}`, {
      headers: { "User-Agent": "TestBot/1.0", Referer: "https://example.com" },
    });

    // Check access log
    const logRes = await app.request(`/reports/share/${linkId}/access`);
    expect(logRes.status).toBe(200);
    const data = await logRes.json();
    expect(data.count).toBe(1);
    expect(data.log[0].userAgent).toBe("TestBot/1.0");
    expect(data.log[0].referrer).toBe("https://example.com");
  });

  it("DELETE /reports/share/:linkId revokes a link", async () => {
    const report = createReport();
    const createRes = await app.request(`/reports/${report.id}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { linkId } = await createRes.json();

    const res = await app.request(`/reports/share/${linkId}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.revoked).toBe(true);
  });

  it("GET /reports/share/:linkId returns 404 after revocation", async () => {
    const report = createReport();
    const createRes = await app.request(`/reports/${report.id}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { linkId } = await createRes.json();

    // Revoke
    await app.request(`/reports/share/${linkId}`, { method: "DELETE" });

    // Try to access
    const res = await app.request(`/reports/share/${linkId}`);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("invalid, expired, or has been revoked");
  });

  it("GET /reports/share/:linkId returns 404 for expired link", async () => {
    const report = createReport();
    const createRes = await app.request(`/reports/${report.id}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expiresAt: "2020-01-01T00:00:00Z" }),
    });
    const { linkId } = await createRes.json();

    const res = await app.request(`/reports/share/${linkId}`);
    expect(res.status).toBe(404);
  });

  it("GET /reports/share/:linkId returns 404 for unknown link", async () => {
    const res = await app.request("/reports/share/NONEXISTENT");
    expect(res.status).toBe(404);
  });

  it("DELETE /reports/share/:linkId returns 404 for unknown link", async () => {
    const res = await app.request("/reports/share/NOPE", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("DELETE /reports/share/:linkId returns 400 for already-revoked link", async () => {
    const report = createReport();
    const createRes = await app.request(`/reports/${report.id}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { linkId } = await createRes.json();

    await app.request(`/reports/share/${linkId}`, { method: "DELETE" });
    const res = await app.request(`/reports/share/${linkId}`, { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("access log records multiple visits", async () => {
    const report = createReport();
    const createRes = await app.request(`/reports/${report.id}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { linkId } = await createRes.json();

    // Visit 3 times
    await app.request(`/reports/share/${linkId}`);
    await app.request(`/reports/share/${linkId}`);
    await app.request(`/reports/share/${linkId}`);

    const logRes = await app.request(`/reports/share/${linkId}/access`);
    const data = await logRes.json();
    expect(data.count).toBe(3);
  });
});
