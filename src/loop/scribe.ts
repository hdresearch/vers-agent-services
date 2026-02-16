/**
 * Scribe tick handler — extracts knowledge from recent log + feed activity
 * into the KB, and decays stale entries by archiving them.
 */

import { emit } from "../events/emit.js";

const BASE_URL = "http://localhost:3000";
const AUTH_HEADERS = () => ({
  Authorization: `Bearer ${process.env.VERS_AUTH_TOKEN || ""}`,
  "Content-Type": "application/json",
});

// ── Fetch helpers ──────────────────────────────────────────────

interface LogEntry {
  id: string;
  text: string;
  agent?: string;
  timestamp: string;
}

interface FeedEvent {
  id: string;
  type: string;
  summary: string;
  detail?: string;
  agent?: string;
  timestamp: string;
}

interface KBEntry {
  id: string;
  type: string;
  content: string;
  tags: string[];
  confidence: number;
  decayDays: number;
  lastReinforced: string;
  archived: boolean;
}

async function fetchRecentLog(window = "6h"): Promise<LogEntry[]> {
  const res = await fetch(`${BASE_URL}/log?last=${window}&limit=100`, {
    headers: AUTH_HEADERS(),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { entries: LogEntry[] };
  return data.entries || [];
}

async function fetchRecentFeed(limit = 100): Promise<FeedEvent[]> {
  const res = await fetch(`${BASE_URL}/feed?limit=${limit}`, {
    headers: AUTH_HEADERS(),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { events: FeedEvent[] };
  return data.events || [];
}

async function fetchKBEntries(active = true): Promise<KBEntry[]> {
  const res = await fetch(`${BASE_URL}/kb/entries?active=${active}`, {
    headers: AUTH_HEADERS(),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { entries: KBEntry[] };
  return data.entries || [];
}

async function postKBEntry(entry: {
  type: string;
  content: string;
  source?: string;
  tags?: string[];
  confidence?: number;
}): Promise<KBEntry | null> {
  const res = await fetch(`${BASE_URL}/kb/entries`, {
    method: "POST",
    headers: AUTH_HEADERS(),
    body: JSON.stringify(entry),
  });
  if (!res.ok) return null;
  return (await res.json()) as KBEntry;
}

async function archiveKBEntry(id: string): Promise<boolean> {
  const res = await fetch(`${BASE_URL}/kb/entries/${id}`, {
    method: "PATCH",
    headers: AUTH_HEADERS(),
    body: JSON.stringify({ archived: true }),
  });
  return res.ok;
}

// ── Knowledge extraction ───────────────────────────────────────

/** Extract knowledge-worthy lines from raw text using prefix patterns */
function extractKnowledgeLines(text: string): Array<{
  type: "warning" | "convention" | "lesson" | "context" | "fact";
  content: string;
}> {
  const results: Array<{ type: "warning" | "convention" | "lesson" | "context" | "fact"; content: string }> = [];
  const lines = text.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 10) continue;

    if (/^(WARNING|WARN|⚠️)[:\s]/i.test(trimmed)) {
      results.push({ type: "warning", content: trimmed.replace(/^(WARNING|WARN|⚠️)[:\s]+/i, "").trim() });
    } else if (/^(CONVENTION|RULE)[:\s]/i.test(trimmed)) {
      results.push({ type: "convention", content: trimmed.replace(/^(CONVENTION|RULE)[:\s]+/i, "").trim() });
    } else if (/^(LESSON|LEARNED|TIL)[:\s]/i.test(trimmed)) {
      results.push({ type: "lesson", content: trimmed.replace(/^(LESSON|LEARNED|TIL)[:\s]+/i, "").trim() });
    } else if (/^(CONTEXT|NOTE)[:\s]/i.test(trimmed)) {
      results.push({ type: "context", content: trimmed.replace(/^(CONTEXT|NOTE)[:\s]+/i, "").trim() });
    } else if (/^(FACT)[:\s]/i.test(trimmed)) {
      results.push({ type: "fact", content: trimmed.replace(/^(FACT)[:\s]+/i, "").trim() });
    }
  }

  return results;
}

/** Deduplicate: skip if content already exists in KB (substring match) */
function isDuplicate(content: string, existing: KBEntry[]): boolean {
  const normalized = content.toLowerCase().trim();
  return existing.some(
    (e) =>
      e.content.toLowerCase().trim() === normalized ||
      e.content.toLowerCase().includes(normalized) ||
      normalized.includes(e.content.toLowerCase().trim()),
  );
}

// ── Decay ──────────────────────────────────────────────────────

/** Check if an entry has expired past its decay window */
function isExpired(entry: KBEntry): boolean {
  const decayMs = entry.decayDays * 24 * 60 * 60 * 1000;
  const reinforcedAt = new Date(entry.lastReinforced).getTime();
  return Date.now() > reinforcedAt + decayMs;
}

// ── Main tick ──────────────────────────────────────────────────

export async function scribeTick(): Promise<void> {
  const stats = { extracted: 0, duplicatesSkipped: 0, decayed: 0, errors: 0 };

  try {
    // 1. Fetch recent activity + existing KB entries in parallel
    const [logEntries, feedEvents, existingKB] = await Promise.all([
      fetchRecentLog("6h"),
      fetchRecentFeed(100),
      fetchKBEntries(true),
    ]);

    // 2. Build text corpus from log entries and feed events
    const textBlocks: Array<{ text: string; source: string }> = [];

    for (const entry of logEntries) {
      textBlocks.push({
        text: entry.text,
        source: `log/${entry.agent || "unknown"}/${entry.id}`,
      });
    }

    for (const event of feedEvents) {
      const text = [event.summary, event.detail].filter(Boolean).join("\n");
      textBlocks.push({
        text,
        source: `feed/${event.agent || "unknown"}/${event.type}`,
      });
    }

    // 3. Extract knowledge from each text block
    for (const block of textBlocks) {
      const extracted = extractKnowledgeLines(block.text);
      for (const item of extracted) {
        if (isDuplicate(item.content, existingKB)) {
          stats.duplicatesSkipped++;
          continue;
        }

        const created = await postKBEntry({
          type: item.type,
          content: item.content,
          source: block.source,
          tags: ["scribe-extracted", "auto"],
          confidence: 4, // auto-extracted starts lower confidence
        });

        if (created) {
          stats.extracted++;
          // Add to existing list for subsequent dedup checks
          existingKB.push(created);
        } else {
          stats.errors++;
        }
      }
    }

    // 4. Decay: archive expired entries
    // Fetch ALL non-archived entries (including inactive/expired)
    const allEntries = await fetchKBEntries(false);
    const nonArchived = allEntries.filter((e) => !e.archived);

    for (const entry of nonArchived) {
      if (isExpired(entry)) {
        const ok = await archiveKBEntry(entry.id);
        if (ok) stats.decayed++;
        else stats.errors++;
      }
    }

    // 5. Emit summary
    emit("loop", "scribe.kb_sync", {
      logEntriesScanned: logEntries.length,
      feedEventsScanned: feedEvents.length,
      knowledgeExtracted: stats.extracted,
      duplicatesSkipped: stats.duplicatesSkipped,
      staleDecayed: stats.decayed,
      errors: stats.errors,
    }, "scribe");
  } catch (err) {
    emit("loop", "scribe.error", {
      error: err instanceof Error ? err.message : String(err),
    }, "scribe");
    throw err;
  }
}
