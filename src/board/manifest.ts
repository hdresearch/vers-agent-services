import type { ServiceManifest } from "../types/manifest.js";
import { boardRoutes } from "./routes.js";

export const manifest: ServiceManifest = {
  name: "board",
  description: "Shared task board for coordinating agent work",
  dependencies: [],
  routes: () => ({
    path: "/board",
    router: boardRoutes,
    auth: true,
  }),
  ui: {
    tabs: [
      {
        id: "dashboard",
        label: "Dashboard",
        icon: "▸",
        scriptUrl: "/ui/static/tabs/dashboard.js",
      },
      {
        id: "review",
        label: "Review",
        icon: "✓",
        scriptUrl: "/ui/static/tabs/review.js",
      },
    ],
    widgets: [
      {
        id: "board-panel",
        slot: "dashboard-left",
        order: 10,
      },
    ],
    stats: [
      { id: "stat-total", label: "tasks", order: 10 },
      { id: "stat-open", label: "open", order: 20 },
      { id: "stat-blocked", label: "blocked", order: 30 },
    ],
  },
};
