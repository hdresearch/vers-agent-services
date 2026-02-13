import type { ServiceManifest } from "../types/manifest.js";
import { reportsRoutes, sharePublicRoutes } from "./routes.js";
import { Hono } from "hono";

/**
 * Reports is special — it has both authenticated routes and public share routes.
 * The public routes are mounted separately without auth in server.ts.
 */
export const manifest: ServiceManifest = {
  name: "reports",
  description: "Agent reports with shareable public links",
  dependencies: [],
  routes: () => ({
    path: "/reports",
    router: reportsRoutes,
    auth: true,
  }),
  ui: {
    widgets: [
      {
        id: "reports-panel",
        slot: "dashboard-right",
        order: 10,
      },
    ],
    stats: [
      { id: "stat-reports", label: "reports", order: 50 },
    ],
  },
};

/** Public share routes — mounted without auth */
export { sharePublicRoutes };
