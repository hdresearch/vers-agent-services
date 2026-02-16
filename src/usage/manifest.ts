import type { ServiceManifest } from "../types/manifest.js";
import { usageRoutes } from "./routes.js";

export const manifest: ServiceManifest = {
  name: "usage",
  description: "Token usage tracking and cost analytics",
  dependencies: [],
  routes: () => ({
    path: "/usage",
    router: usageRoutes,
    auth: true,
  }),
  ui: {
    tabs: [
      {
        id: "metrics",
        label: "Metrics",
        icon: "📊",
        scriptUrl: "/ui/static/tabs/metrics-tab.js",
      },
    ],
    scripts: [
      "/ui/static/speedometer.js",
      "/ui/static/metrics.js",
      "/ui/static/analytics.js",
    ],
  },
};
