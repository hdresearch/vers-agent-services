import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

// --- Types ---

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKeyConfigKey: string; // key in config store, e.g. "ANTHROPIC_API_KEY"
  models: string[];        // model name prefixes to route here
  defaultHeaders?: Record<string, string>;
}

export interface RouteEntry {
  model: string;
  provider: string;
  addedAt: string;
}

export interface RateLimitConfig {
  agent: string;
  requestsPerMinute: number;
  tokensPerMinute: number;
}

export interface RequestLog {
  id: string;
  agent: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  latencyMs: number;
  status: number;
  createdAt: string;
}

// Default provider configs
const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    name: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyConfigKey: "ANTHROPIC_API_KEY",
    models: ["claude-"],
    defaultHeaders: { "anthropic-version": "2023-06-01" },
  },
  {
    name: "openai",
    baseUrl: "https://api.openai.com",
    apiKeyConfigKey: "OPENAI_API_KEY",
    models: ["gpt-", "o1-", "o3-", "o4-"],
  },
];

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class RouterStore {
  private db: Database.Database;

  constructor(dbPath = "data/router.db") {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS providers (
        name TEXT PRIMARY KEY,
        base_url TEXT NOT NULL,
        api_key_config_key TEXT NOT NULL,
        models TEXT NOT NULL,
        default_headers TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rate_limits (
        agent TEXT PRIMARY KEY,
        requests_per_minute INTEGER NOT NULL DEFAULT 60,
        tokens_per_minute INTEGER NOT NULL DEFAULT 1000000,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS request_log (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER NOT NULL DEFAULT 0,
        status INTEGER NOT NULL DEFAULT 200,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_request_log_agent ON request_log(agent);
      CREATE INDEX IF NOT EXISTS idx_request_log_created ON request_log(created_at);
    `);

    // Seed default providers if empty
    const count = this.db.prepare("SELECT COUNT(*) as cnt FROM providers").get() as { cnt: number };
    if (count.cnt === 0) {
      this.seedProviders();
    }
  }

  private seedProviders(): void {
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO providers (name, base_url, api_key_config_key, models, default_headers, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const p of DEFAULT_PROVIDERS) {
      insert.run(
        p.name,
        p.baseUrl,
        p.apiKeyConfigKey,
        JSON.stringify(p.models),
        p.defaultHeaders ? JSON.stringify(p.defaultHeaders) : null,
        now
      );
    }
  }

  // --- Providers ---

  getProvider(name: string): ProviderConfig | null {
    const row = this.db.prepare(
      "SELECT name, base_url, api_key_config_key, models, default_headers FROM providers WHERE name = ?"
    ).get(name) as any;
    if (!row) return null;
    return {
      name: row.name,
      baseUrl: row.base_url,
      apiKeyConfigKey: row.api_key_config_key,
      models: JSON.parse(row.models),
      defaultHeaders: row.default_headers ? JSON.parse(row.default_headers) : undefined,
    };
  }

  getAllProviders(): ProviderConfig[] {
    const rows = this.db.prepare(
      "SELECT name, base_url, api_key_config_key, models, default_headers FROM providers ORDER BY name"
    ).all() as any[];
    return rows.map((row) => ({
      name: row.name,
      baseUrl: row.base_url,
      apiKeyConfigKey: row.api_key_config_key,
      models: JSON.parse(row.models),
      defaultHeaders: row.default_headers ? JSON.parse(row.default_headers) : undefined,
    }));
  }

  setProvider(config: ProviderConfig): void {
    if (!config.name) throw new ValidationError("provider name required");
    if (!config.baseUrl) throw new ValidationError("baseUrl required");
    if (!config.apiKeyConfigKey) throw new ValidationError("apiKeyConfigKey required");

    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO providers (name, base_url, api_key_config_key, models, default_headers, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET base_url = ?, api_key_config_key = ?, models = ?, default_headers = ?, updated_at = ?`
    ).run(
      config.name, config.baseUrl, config.apiKeyConfigKey, JSON.stringify(config.models || []),
      config.defaultHeaders ? JSON.stringify(config.defaultHeaders) : null, now,
      config.baseUrl, config.apiKeyConfigKey, JSON.stringify(config.models || []),
      config.defaultHeaders ? JSON.stringify(config.defaultHeaders) : null, now
    );
  }

  // --- Model Routing ---

  resolveProvider(model: string): ProviderConfig | null {
    const providers = this.getAllProviders();
    for (const provider of providers) {
      for (const prefix of provider.models) {
        if (model.startsWith(prefix) || model === prefix) {
          return provider;
        }
      }
    }
    return null;
  }

  // --- Rate Limits ---

  getRateLimit(agent: string): RateLimitConfig {
    const row = this.db.prepare(
      "SELECT agent, requests_per_minute, tokens_per_minute FROM rate_limits WHERE agent = ?"
    ).get(agent) as any;
    if (!row) {
      return { agent, requestsPerMinute: 60, tokensPerMinute: 1_000_000 };
    }
    return {
      agent: row.agent,
      requestsPerMinute: row.requests_per_minute,
      tokensPerMinute: row.tokens_per_minute,
    };
  }

  setRateLimit(config: RateLimitConfig): void {
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO rate_limits (agent, requests_per_minute, tokens_per_minute, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(agent) DO UPDATE SET requests_per_minute = ?, tokens_per_minute = ?, updated_at = ?`
    ).run(config.agent, config.requestsPerMinute, config.tokensPerMinute, now,
      config.requestsPerMinute, config.tokensPerMinute, now);
  }

  // --- Request Logging ---

  logRequest(log: Omit<RequestLog, "id" | "createdAt">): RequestLog {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO request_log (id, agent, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, latency_ms, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, log.agent, log.model, log.provider, log.inputTokens, log.outputTokens,
      log.cacheReadTokens, log.cacheWriteTokens, log.latencyMs, log.status, createdAt);
    return { id, ...log, createdAt };
  }

  getRequestStats(range = "1h"): {
    totalRequests: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    byAgent: Record<string, { requests: number; inputTokens: number; outputTokens: number }>;
    byModel: Record<string, { requests: number; inputTokens: number; outputTokens: number }>;
  } {
    const since = rangeToDate(range);
    const rows = this.db.prepare(
      `SELECT agent, model, COUNT(*) as cnt,
              SUM(input_tokens) as input_sum, SUM(output_tokens) as output_sum
       FROM request_log WHERE created_at >= ? GROUP BY agent, model`
    ).all(since) as any[];

    const result = {
      totalRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      byAgent: {} as Record<string, { requests: number; inputTokens: number; outputTokens: number }>,
      byModel: {} as Record<string, { requests: number; inputTokens: number; outputTokens: number }>,
    };

    for (const row of rows) {
      result.totalRequests += row.cnt;
      result.totalInputTokens += row.input_sum;
      result.totalOutputTokens += row.output_sum;

      if (!result.byAgent[row.agent]) {
        result.byAgent[row.agent] = { requests: 0, inputTokens: 0, outputTokens: 0 };
      }
      result.byAgent[row.agent].requests += row.cnt;
      result.byAgent[row.agent].inputTokens += row.input_sum;
      result.byAgent[row.agent].outputTokens += row.output_sum;

      if (!result.byModel[row.model]) {
        result.byModel[row.model] = { requests: 0, inputTokens: 0, outputTokens: 0 };
      }
      result.byModel[row.model].requests += row.cnt;
      result.byModel[row.model].inputTokens += row.input_sum;
      result.byModel[row.model].outputTokens += row.output_sum;
    }

    return result;
  }

  // --- Maintenance ---

  pruneOldLogs(olderThanDays = 30): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86400000).toISOString();
    const result = this.db.prepare("DELETE FROM request_log WHERE created_at < ?").run(cutoff);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}

function rangeToDate(range: string): string {
  const match = range.match(/^(\d+)(h|d|m)$/);
  if (!match) return new Date(Date.now() - 3600000).toISOString(); // default 1h
  const [, num, unit] = match;
  const ms = { h: 3600000, d: 86400000, m: 60000 }[unit] || 3600000;
  return new Date(Date.now() - parseInt(num) * ms).toISOString();
}
