import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DocsStore, ValidationError, NotFoundError } from "../docs/store.js";
import { unlinkSync } from "node:fs";

describe("DocsStore", () => {
  let store: DocsStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `/tmp/docs-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    store = new DocsStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try { unlinkSync(dbPath); } catch {}
    try { unlinkSync(dbPath + "-wal"); } catch {}
    try { unlinkSync(dbPath + "-shm"); } catch {}
  });

  // ── Document CRUD ────────────────────────────────────────────────────────

  describe("create", () => {
    it("creates a document with defaults", () => {
      const doc = store.create({
        title: "Seed Spec v1",
        author: "Ada",
        content: "# Seed Spec\n\nDraft content here.",
      });

      expect(doc.id).toBeTruthy();
      expect(doc.title).toBe("Seed Spec v1");
      expect(doc.author).toBe("Ada");
      expect(doc.status).toBe("draft");
      expect(doc.tags).toEqual([]);
      expect(doc.currentHash).toBeTruthy();
      expect(doc.currentVersionId).toBeTruthy();
    });

    it("creates with explicit status and tags", () => {
      const doc = store.create({
        title: "Published Doc",
        author: "Duncan",
        content: "Content",
        status: "published",
        tags: ["seed", "spec"],
      });

      expect(doc.status).toBe("published");
      expect(doc.tags).toEqual(["seed", "spec"]);
    });

    it("rejects missing title", () => {
      expect(() => store.create({
        title: "",
        author: "Ada",
        content: "x",
      })).toThrow(ValidationError);
    });

    it("rejects missing author", () => {
      expect(() => store.create({
        title: "T",
        author: "",
        content: "x",
      })).toThrow(ValidationError);
    });

    it("rejects invalid status", () => {
      expect(() => store.create({
        title: "T",
        author: "A",
        content: "x",
        status: "invalid" as any,
      })).toThrow(ValidationError);
    });
  });

  describe("get", () => {
    it("gets a document by id", () => {
      const created = store.create({ title: "T", author: "A", content: "C" });
      const got = store.get(created.id);
      expect(got.id).toBe(created.id);
      expect(got.content).toBe("C");
    });

    it("throws NotFoundError for missing doc", () => {
      expect(() => store.get("NONEXISTENT")).toThrow(NotFoundError);
    });
  });

  describe("list", () => {
    it("lists all documents", () => {
      store.create({ title: "First", author: "A", content: "1" });
      store.create({ title: "Second", author: "B", content: "2" });
      const docs = store.list();
      expect(docs.length).toBe(2);
      // Both created at nearly the same time; just verify both exist
      const titles = docs.map((d) => d.title).sort();
      expect(titles).toEqual(["First", "Second"]);
    });

    it("filters by status", () => {
      store.create({ title: "Draft", author: "A", content: "d", status: "draft" });
      store.create({ title: "Published", author: "A", content: "p", status: "published" });
      const drafts = store.list({ status: "draft" });
      expect(drafts.length).toBe(1);
      expect(drafts[0].title).toBe("Draft");
    });

    it("filters by author", () => {
      store.create({ title: "A1", author: "Ada", content: "x" });
      store.create({ title: "D1", author: "Duncan", content: "y" });
      const adaDocs = store.list({ author: "Ada" });
      expect(adaDocs.length).toBe(1);
    });

    it("filters by tag", () => {
      store.create({ title: "T1", author: "A", content: "x", tags: ["seed"] });
      store.create({ title: "T2", author: "A", content: "y", tags: ["other"] });
      const seedDocs = store.list({ tag: "seed" });
      expect(seedDocs.length).toBe(1);
      expect(seedDocs[0].title).toBe("T1");
    });
  });

  describe("update", () => {
    it("updates title without creating new version", () => {
      const doc = store.create({ title: "Old", author: "A", content: "C" });
      const updated = store.update(doc.id, { title: "New", author: "A" });
      expect(updated.title).toBe("New");
      const versions = store.getVersions(doc.id);
      expect(versions.length).toBe(1); // only initial version
    });

    it("creates new version when content changes", () => {
      const doc = store.create({ title: "T", author: "A", content: "v1" });
      store.update(doc.id, { content: "v2", author: "B", message: "Updated content" });
      const versions = store.getVersions(doc.id);
      expect(versions.length).toBe(2);
      expect(versions[0].versionNumber).toBe(2);
      expect(versions[0].content).toBe("v2");
      expect(versions[0].author).toBe("B");
      expect(versions[1].versionNumber).toBe(1);
    });

    it("tracks different hash for different content", () => {
      const doc = store.create({ title: "T", author: "A", content: "v1" });
      const updated = store.update(doc.id, { content: "v2", author: "A" });
      expect(updated.currentHash).not.toBe(doc.currentHash);
    });

    it("does not create version for same content", () => {
      const doc = store.create({ title: "T", author: "A", content: "same" });
      store.update(doc.id, { content: "same", author: "B" });
      const versions = store.getVersions(doc.id);
      expect(versions.length).toBe(1);
    });

    it("updates status", () => {
      const doc = store.create({ title: "T", author: "A", content: "C" });
      const updated = store.update(doc.id, { status: "published", author: "A" });
      expect(updated.status).toBe("published");
    });

    it("throws NotFoundError for missing doc", () => {
      expect(() => store.update("MISSING", { author: "A" })).toThrow(NotFoundError);
    });
  });

  describe("delete", () => {
    it("deletes a document", () => {
      const doc = store.create({ title: "T", author: "A", content: "C" });
      expect(store.delete(doc.id)).toBe(true);
      expect(() => store.get(doc.id)).toThrow(NotFoundError);
    });

    it("returns false for non-existent doc", () => {
      expect(store.delete("MISSING")).toBe(false);
    });
  });

  // ── Versions ─────────────────────────────────────────────────────────────

  describe("versions", () => {
    it("initial version is created on doc creation", () => {
      const doc = store.create({ title: "T", author: "A", content: "initial" });
      const versions = store.getVersions(doc.id);
      expect(versions.length).toBe(1);
      expect(versions[0].versionNumber).toBe(1);
      expect(versions[0].message).toBe("Initial version");
    });

    it("get specific version by id", () => {
      const doc = store.create({ title: "T", author: "A", content: "v1" });
      store.update(doc.id, { content: "v2", author: "B" });
      const versions = store.getVersions(doc.id);
      const v1 = store.getVersion(doc.id, versions[1].id);
      expect(v1.content).toBe("v1");
    });

    it("throws NotFoundError for missing version", () => {
      const doc = store.create({ title: "T", author: "A", content: "v1" });
      expect(() => store.getVersion(doc.id, "MISSING")).toThrow(NotFoundError);
    });
  });

  // ── Comments ─────────────────────────────────────────────────────────────

  describe("comments", () => {
    it("adds a comment", () => {
      const doc = store.create({ title: "T", author: "A", content: "C" });
      const comment = store.addComment(doc.id, {
        author: "Reviewer",
        content: "Looks good!",
      });
      expect(comment.id).toBeTruthy();
      expect(comment.docId).toBe(doc.id);
      expect(comment.author).toBe("Reviewer");
      expect(comment.parentCommentId).toBeNull();
    });

    it("adds comment with line reference", () => {
      const doc = store.create({ title: "T", author: "A", content: "C" });
      const comment = store.addComment(doc.id, {
        author: "R",
        content: "Fix this line",
        lineRef: "L42",
      });
      expect(comment.lineRef).toBe("L42");
    });

    it("supports threaded replies", () => {
      const doc = store.create({ title: "T", author: "A", content: "C" });
      const parent = store.addComment(doc.id, { author: "R1", content: "Question?" });
      const reply = store.addComment(doc.id, {
        author: "R2",
        content: "Answer!",
        parentCommentId: parent.id,
      });
      expect(reply.parentCommentId).toBe(parent.id);
    });

    it("rejects comment on non-existent doc", () => {
      expect(() => store.addComment("MISSING", {
        author: "R",
        content: "Hi",
      })).toThrow(NotFoundError);
    });

    it("rejects comment with non-existent parent", () => {
      const doc = store.create({ title: "T", author: "A", content: "C" });
      expect(() => store.addComment(doc.id, {
        author: "R",
        content: "Hi",
        parentCommentId: "MISSING",
      })).toThrow(NotFoundError);
    });

    it("lists comments in order", () => {
      const doc = store.create({ title: "T", author: "A", content: "C" });
      store.addComment(doc.id, { author: "R1", content: "First" });
      store.addComment(doc.id, { author: "R2", content: "Second" });
      const comments = store.getComments(doc.id);
      expect(comments.length).toBe(2);
      expect(comments[0].content).toBe("First");
    });
  });

  // ── Contributors ─────────────────────────────────────────────────────────

  describe("contributors", () => {
    it("tracks the initial author", () => {
      const doc = store.create({ title: "T", author: "Ada", content: "C" });
      const contributors = store.getContributors(doc.id);
      expect(contributors.length).toBe(1);
      expect(contributors[0].author).toBe("Ada");
      expect(contributors[0].edits).toBe(1);
    });

    it("tracks multiple contributors", () => {
      const doc = store.create({ title: "T", author: "Ada", content: "v1" });
      store.update(doc.id, { content: "v2", author: "Duncan" });
      const contributors = store.getContributors(doc.id);
      expect(contributors.length).toBe(2);
    });

    it("increments edit count for same author", () => {
      const doc = store.create({ title: "T", author: "Ada", content: "v1" });
      store.update(doc.id, { content: "v2", author: "Ada" });
      store.update(doc.id, { content: "v3", author: "Ada" });
      const contributors = store.getContributors(doc.id);
      expect(contributors.length).toBe(1);
      expect(contributors[0].edits).toBe(3); // 1 create + 2 updates
    });
  });

  // ── Public access ────────────────────────────────────────────────────────

  describe("public access", () => {
    it("only lists published documents", () => {
      store.create({ title: "Draft", author: "A", content: "d", status: "draft" });
      store.create({ title: "Pub", author: "A", content: "p", status: "published" });
      const published = store.listPublished();
      expect(published.length).toBe(1);
      expect(published[0].title).toBe("Pub");
    });

    it("getPublished returns published doc", () => {
      const doc = store.create({ title: "Pub", author: "A", content: "p", status: "published" });
      const got = store.getPublished(doc.id);
      expect(got.id).toBe(doc.id);
    });

    it("getPublished throws for draft doc", () => {
      const doc = store.create({ title: "Draft", author: "A", content: "d" });
      expect(() => store.getPublished(doc.id)).toThrow(NotFoundError);
    });
  });

  // ── Search ───────────────────────────────────────────────────────────────

  describe("search", () => {
    it("finds documents by content", () => {
      store.create({ title: "Unrelated", author: "A", content: "nothing to see here" });
      store.create({ title: "Seed Spec", author: "A", content: "The seed specification defines..." });
      const results = store.search("seed specification");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((d) => d.title === "Seed Spec")).toBe(true);
    });

    it("finds documents by title", () => {
      store.create({ title: "Collaboration Design", author: "Duncan", content: "body" });
      const results = store.search("Collaboration");
      expect(results.length).toBe(1);
    });

    it("returns empty for no match", () => {
      store.create({ title: "T", author: "A", content: "C" });
      const results = store.search("xyzzy123nonexistent");
      expect(results.length).toBe(0);
    });

    it("returns empty for empty query", () => {
      expect(store.search("")).toEqual([]);
      expect(store.search("  ")).toEqual([]);
    });
  });
});
