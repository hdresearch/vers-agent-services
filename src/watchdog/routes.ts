import { Hono } from "hono";
import { WatchdogStore, type FeedAdapter, type RegistryAdapter, type BoardAdapter } from "./store.js";
import type { FeedStore } from "../feed/store.js";
import type { RegistryStore } from "../registry/store.js";
import type { BoardStore } from "../board/store.js";

// ── Adapter factories ────────────────────────────────────────────────────────

export function makeFeedAdapter(feedStore: FeedStore): FeedAdapter {
  return {
    getLatestEvent(agent: string) {
      const events = feedStore.list({ agent, limit: 1 });
      if (events.length === 0) return null;
      const e = events[0];
      return { id: e.id, timestamp: e.timestamp };
    },
    publishEvent(agent: string, type: string, summary: string, detail?: string) {
      feedStore.publish({
        agent,
        type: type as any,
        summary,
        detail,
      });
    },
  };
}

export function makeRegistryAdapter(registryStore: RegistryStore): RegistryAdapter {
  return {
    getRunningAgents() {
      // Get lieutenants and workers that are running
      const lieutenants = registryStore.discover("lieutenant");
      const workers = registryStore.discover("worker");
      return [...lieutenants, ...workers].map((vm) => ({
        id: vm.id,
        name: vm.name,
      }));
    },
  };
}

export function makeBoardAdapter(boardStore: BoardStore): BoardAdapter {
  return {
    findTaskByAgent(agent: string): string | null {
      // Search for in_progress tasks assigned to this agent
      const tasks = boardStore.listTasks({ assignee: agent, status: "in_progress" as any });
      if (tasks.length > 0) return tasks[0].id;
      // Fallback: any task assigned to agent
      const allTasks = boardStore.listTasks({ assignee: agent });
      if (allTasks.length > 0) return allTasks[0].id;
      return null;
    },
    addNote(taskId: string, author: string, content: string) {
      try {
        boardStore.addNote(taskId, { author, content, type: "blocker" });
      } catch {
        // Task may not exist — don't crash watchdog
      }
    },
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

export function createWatchdogRoutes(
  feedStore: FeedStore,
  registryStore: RegistryStore,
  boardStore: BoardStore,
): { routes: Hono; store: WatchdogStore } {
  const feedAdapter = makeFeedAdapter(feedStore);
  const registryAdapter = makeRegistryAdapter(registryStore);
  const boardAdapter = makeBoardAdapter(boardStore);

  const watchdog = new WatchdogStore(feedAdapter, registryAdapter, boardAdapter);
  const routes = new Hono();

  // GET /status — health of all registered agents
  routes.get("/status", (c) => {
    const agents = watchdog.getAll();
    const now = new Date();
    const status = agents.map((a) => ({
      ...a,
      timeSinceLastActivity: a.lastEventTime
        ? `${Math.round((now.getTime() - new Date(a.lastEventTime).getTime()) / 60000)}min`
        : "never",
    }));
    return c.json({
      running: watchdog.running,
      agentCount: agents.length,
      zombieCount: watchdog.getZombies().length,
      agents: status,
    });
  });

  // GET /zombies — confirmed zombies only
  routes.get("/zombies", (c) => {
    const zombies = watchdog.getZombies();
    return c.json({ zombies, count: zombies.length });
  });

  // POST /start — start monitoring loop
  routes.post("/start", (c) => {
    if (watchdog.running) {
      return c.json({ message: "Watchdog already running" }, 200);
    }
    watchdog.start();
    return c.json({ message: "Watchdog started", startedAt: new Date().toISOString() }, 201);
  });

  // POST /stop — stop monitoring loop
  routes.post("/stop", (c) => {
    if (!watchdog.running) {
      return c.json({ message: "Watchdog not running" }, 200);
    }
    watchdog.stop();
    return c.json({ message: "Watchdog stopped" });
  });

  // POST /check — trigger a manual check (useful for testing)
  routes.post("/check", (c) => {
    watchdog.check();
    return c.json({ message: "Check complete", agents: watchdog.getAll() });
  });

  return { routes, store: watchdog };
}
