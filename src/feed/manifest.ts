import type { ServiceManifest } from "../types/manifest.js";
import { feedRoutes } from "./routes.js";

export const manifest: ServiceManifest = {
  name: "feed",
  description: "Real-time event feed with SSE streaming",
  dependencies: [],
  routes: () => ({
    path: "/feed",
    router: feedRoutes,
    auth: true,
  }),
  ui: {
    widgets: [
      {
        id: "feed-panel",
        slot: "dashboard-center",
        order: 10,
      },
    ],
    stats: [
      { id: "stat-events", label: "events", order: 40 },
    ],
  },
};
