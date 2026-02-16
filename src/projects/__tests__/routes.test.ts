import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { projectRoutes, projectStore } from "../routes.js";
import { unlinkSync, existsSync } from "node:fs";

// We test routes by mounting them on a test app
// Note: projectStore is a singleton — we re-create the DB between tests

describe("Project Routes", () => {
  const app = new Hono();
  app.route("/projects", projectRoutes);

  const request = (path: string, init?: RequestInit) =>
    app.request(path, init);

  describe("POST /projects", () => {
    it("creates a project", async () => {
      const res = await request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "test-create",
          displayName: "Test Create",
          description: "A test project",
          tags: ["test"],
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe("test-create");
      expect(body.displayName).toBe("Test Create");
      expect(body.id).toBeTruthy();

      // Cleanup
      projectStore.delete(body.id);
    });

    it("returns 400 for missing name", async () => {
      const res = await request("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "No Name" }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /projects", () => {
    let projectId: string;

    beforeEach(async () => {
      const p = projectStore.create({
        name: "list-test",
        displayName: "List Test",
        tags: ["alpha"],
      });
      projectId = p.id;
    });

    afterEach(() => {
      projectStore.delete(projectId);
    });

    it("lists projects", async () => {
      const res = await request("/projects");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.projects.length).toBeGreaterThanOrEqual(1);
      expect(body.count).toBeGreaterThanOrEqual(1);
    });

    it("filters by status", async () => {
      const res = await request("/projects?status=active");
      const body = await res.json();
      for (const p of body.projects) {
        expect(p.status).toBe("active");
      }
    });
  });

  describe("GET /projects/:id", () => {
    let projectId: string;

    beforeEach(() => {
      const p = projectStore.create({
        name: "get-test",
        displayName: "Get Test",
      });
      projectId = p.id;
    });

    afterEach(() => {
      projectStore.delete(projectId);
    });

    it("gets by id", async () => {
      const res = await request(`/projects/${projectId}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("get-test");
    });

    it("gets by name", async () => {
      const res = await request("/projects/get-test");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("get-test");
    });

    it("returns 404 for missing", async () => {
      const res = await request("/projects/nonexistent");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /projects/:id", () => {
    let projectId: string;

    beforeEach(() => {
      const p = projectStore.create({
        name: "patch-test",
        displayName: "Patch Test",
      });
      projectId = p.id;
    });

    afterEach(() => {
      projectStore.delete(projectId);
    });

    it("updates a project", async () => {
      const res = await request(`/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "paused", tags: ["updated"] }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("paused");
      expect(body.tags).toEqual(["updated"]);
    });
  });

  describe("DELETE /projects/:id", () => {
    it("deletes a project", async () => {
      const p = projectStore.create({
        name: "delete-test",
        displayName: "Delete Test",
      });
      const res = await request(`/projects/${p.id}`, { method: "DELETE" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe(true);
    });

    it("returns 404 for missing", async () => {
      const res = await request("/projects/nonexistent", {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });
});
