import { Hono } from "hono";
import { ShareStore } from "./share-store.js";
import { ReportsStore } from "./store.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

function getReportHtml(): string {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    return readFileSync(join(__dirname, "..", "ui", "static", "report.html"), "utf-8");
  } catch {
    return readFileSync(join(process.cwd(), "src", "ui", "static", "report.html"), "utf-8");
  }
}

/**
 * Creates admin routes for share link management (require auth).
 * Mounted under /reports so paths are relative to that.
 */
export function createShareAdminRoutes(shareStore: ShareStore, reportsStore: ReportsStore): Hono {
  const routes = new Hono();

  // POST /reports/:id/share — create a share link
  routes.post("/:id/share", async (c) => {
    const reportId = c.req.param("id");
    const report = reportsStore.get(reportId);
    if (!report) {
      return c.json({ error: "report not found" }, 404);
    }

    const body = await c.req.json().catch(() => ({}));
    const link = shareStore.createLink({
      reportId,
      createdBy: body.createdBy || "admin",
      expiresAt: body.expiresAt,
      label: body.label,
    });

    const host = c.req.header("host") || "localhost:3000";
    const proto = c.req.header("x-forwarded-proto") || "http";
    const url = `${proto}://${host}/reports/share/${link.linkId}`;

    return c.json({ linkId: link.linkId, url }, 201);
  });

  // GET /reports/:id/shares — list share links for a report
  routes.get("/:id/shares", (c) => {
    const reportId = c.req.param("id");
    const report = reportsStore.get(reportId);
    if (!report) {
      return c.json({ error: "report not found" }, 404);
    }

    const links = shareStore.listLinksForReport(reportId);
    return c.json({ links, count: links.length });
  });

  // DELETE /reports/share/:linkId — revoke a share link
  routes.delete("/share/:linkId", (c) => {
    const linkId = c.req.param("linkId");
    const link = shareStore.getLink(linkId);
    if (!link) {
      return c.json({ error: "share link not found" }, 404);
    }
    const revoked = shareStore.revokeLink(linkId);
    if (!revoked) {
      return c.json({ error: "link already revoked" }, 400);
    }
    return c.json({ revoked: true });
  });

  // GET /reports/share/:linkId/access — access log for a link
  routes.get("/share/:linkId/access", (c) => {
    const linkId = c.req.param("linkId");
    const link = shareStore.getLink(linkId);
    if (!link) {
      return c.json({ error: "share link not found" }, 404);
    }
    const log = shareStore.getAccessLog(linkId);
    return c.json({ log, count: log.length });
  });

  return routes;
}

/**
 * Creates the public share route (NO auth required).
 * Mounted at /reports/share/:linkId
 */
export function createSharePublicRoutes(shareStore: ShareStore, reportsStore: ReportsStore): Hono {
  const routes = new Hono();

  // GET /reports/share/:linkId — public report access via share link
  routes.get("/share/:linkId", (c) => {
    const linkId = c.req.param("linkId");
    const link = shareStore.validateLink(linkId);

    if (!link) {
      return c.html(
        `<!DOCTYPE html>
<html><head><title>Not Found</title>
<style>body{font-family:system-ui;background:#111;color:#aaa;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}
.msg{text-align:center}.msg h1{color:#e55;font-size:48px;margin:0}.msg p{font-size:16px;margin-top:12px}</style></head>
<body><div class="msg"><h1>404</h1><p>This share link is invalid, expired, or has been revoked.</p></div></body></html>`,
        404
      );
    }

    const report = reportsStore.get(link.reportId);
    if (!report) {
      return c.html(
        `<!DOCTYPE html>
<html><head><title>Not Found</title>
<style>body{font-family:system-ui;background:#111;color:#aaa;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}
.msg{text-align:center}.msg h1{color:#e55;font-size:48px;margin:0}.msg p{font-size:16px;margin-top:12px}</style></head>
<body><div class="msg"><h1>404</h1><p>The report associated with this share link no longer exists.</p></div></body></html>`,
        404
      );
    }

    // Record access
    shareStore.recordAccess(linkId, link.reportId, {
      ip: c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || undefined,
      userAgent: c.req.header("user-agent") || undefined,
      referrer: c.req.header("referer") || undefined,
    });

    // Render the report inline using the report.html template
    // We inject the report data directly so no additional API call is needed
    const template = getReportHtml();
    const html = template.replace(
      "loadReport();",
      `
      // Injected report data — no API call needed for shared reports
      (function() {
        const report = ${JSON.stringify({
          id: report.id,
          title: report.title,
          author: report.author,
          content: report.content,
          tags: report.tags,
          createdAt: report.createdAt,
        })};
        document.title = report.title + ' — Shared Report';
        const container = document.getElementById('report-container');
        const tags = (report.tags || []).map(t => '<span class="tag">' + esc(t) + '</span>').join(' ');
        container.innerHTML =
          '<div class="report-title">' + esc(report.title) + '</div>' +
          '<div class="report-meta">' +
            '<span class="author">@' + esc(report.author) + '</span>' +
            '<span class="date">' + formatDate(report.createdAt) + '</span>' +
            tags +
          '</div>' +
          '<div class="report-content">' + renderMarkdown(report.content) + '</div>';
      })();
      `
    );

    return c.html(html);
  });

  return routes;
}
