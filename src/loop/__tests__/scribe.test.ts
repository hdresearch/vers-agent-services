import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the emit module before importing scribe
vi.mock("../../events/emit.js", () => ({
  emit: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Must import after mocking
const { scribeTick } = await import("../scribe.js");

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scribeTick", () => {
  it("extracts knowledge from log entries and posts to KB", async () => {
    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      const u = typeof url === "string" ? url : (url as URL).toString();

      if (u.includes("/log?")) {
        return jsonResponse({
          entries: [
            { id: "L1", text: "WARNING: deploy broke the staging env", agent: "worker-1", timestamp: new Date().toISOString() },
            { id: "L2", text: "just a normal log line", agent: "worker-2", timestamp: new Date().toISOString() },
            { id: "L3", text: "LESSON: always run smoke tests after deploy", agent: "worker-1", timestamp: new Date().toISOString() },
          ],
        });
      }

      if (u.includes("/feed?")) {
        return jsonResponse({
          events: [
            { id: "F1", type: "finding", summary: "FACT: prod runs on port 3000", agent: "sentinel", timestamp: new Date().toISOString() },
          ],
        });
      }

      if (u.includes("/kb/entries?active=true")) {
        return jsonResponse({ entries: [] });
      }

      if (u.includes("/kb/entries?active=false")) {
        return jsonResponse({
          entries: [
            {
              id: "KB_OLD",
              type: "context",
              content: "old stale entry",
              tags: [],
              confidence: 3,
              decayDays: 1,
              lastReinforced: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
              archived: false,
            },
          ],
        });
      }

      // POST /kb/entries
      if (u.endsWith("/kb/entries") && opts?.method === "POST") {
        const body = JSON.parse(opts.body as string);
        return jsonResponse({ id: `KB_NEW_${Math.random()}`, ...body, archived: false, lastReinforced: new Date().toISOString() }, 201);
      }

      // PATCH /kb/entries/:id
      if (u.includes("/kb/entries/") && opts?.method === "PATCH") {
        return jsonResponse({ id: "KB_OLD", archived: true });
      }

      return jsonResponse({});
    });

    await scribeTick();

    const calls = mockFetch.mock.calls.map(([url, opts]: [string, RequestInit?]) => ({
      url: typeof url === "string" ? url : url.toString(),
      method: opts?.method || "GET",
    }));

    // Should fetch log, feed, KB
    expect(calls.some((c) => c.url.includes("/log?") && c.method === "GET")).toBe(true);
    expect(calls.some((c) => c.url.includes("/feed?") && c.method === "GET")).toBe(true);
    expect(calls.some((c) => c.url.includes("/kb/entries?active=true") && c.method === "GET")).toBe(true);

    // Should POST 3 new KB entries (WARNING + LESSON from log, FACT from feed)
    const postCalls = calls.filter((c) => c.url.endsWith("/kb/entries") && c.method === "POST");
    expect(postCalls.length).toBe(3);

    // Should PATCH (archive) 1 stale entry
    const patchCalls = calls.filter((c) => c.url.includes("/kb/entries/KB_OLD") && c.method === "PATCH");
    expect(patchCalls.length).toBe(1);
  });

  it("skips duplicates that already exist in KB", async () => {
    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      const u = typeof url === "string" ? url : (url as URL).toString();

      if (u.includes("/log?")) {
        return jsonResponse({
          entries: [
            { id: "L1", text: "WARNING: deploy broke the staging env", agent: "w1", timestamp: new Date().toISOString() },
          ],
        });
      }

      if (u.includes("/feed?")) {
        return jsonResponse({ events: [] });
      }

      if (u.includes("/kb/entries?active=true")) {
        return jsonResponse({
          entries: [
            { id: "KB_EXISTING", type: "warning", content: "deploy broke the staging env", tags: [], confidence: 5, decayDays: 7, lastReinforced: new Date().toISOString(), archived: false },
          ],
        });
      }

      if (u.includes("/kb/entries?active=false")) {
        return jsonResponse({ entries: [] });
      }

      return jsonResponse({});
    });

    await scribeTick();

    const postCalls = mockFetch.mock.calls.filter(
      ([url, opts]: [string, RequestInit?]) => typeof url === "string" && url.endsWith("/kb/entries") && opts?.method === "POST"
    );
    expect(postCalls.length).toBe(0);
  });

  it("does not decay entries that are still fresh", async () => {
    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      const u = typeof url === "string" ? url : (url as URL).toString();

      if (u.includes("/log?")) return jsonResponse({ entries: [] });
      if (u.includes("/feed?")) return jsonResponse({ events: [] });
      if (u.includes("/kb/entries?active=true")) return jsonResponse({ entries: [] });

      if (u.includes("/kb/entries?active=false")) {
        return jsonResponse({
          entries: [
            {
              id: "KB_FRESH",
              type: "fact",
              content: "still fresh",
              tags: [],
              confidence: 8,
              decayDays: 365,
              lastReinforced: new Date().toISOString(), // just now
              archived: false,
            },
          ],
        });
      }

      return jsonResponse({});
    });

    await scribeTick();

    // No PATCH calls — entry is still fresh
    const patchCalls = mockFetch.mock.calls.filter(
      ([url, opts]: [string, RequestInit?]) => typeof url === "string" && url.includes("/kb/entries/") && opts?.method === "PATCH"
    );
    expect(patchCalls.length).toBe(0);
  });
});
