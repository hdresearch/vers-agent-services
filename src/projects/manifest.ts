import type { ServiceManifest } from "../types/manifest.js";
import { projectRoutes } from "./routes.js";

export const manifest: ServiceManifest = {
  name: "projects",
  description: "Unified project view across all fleet services",
  dependencies: ["board", "feed", "reports"],
  routes: () => ({
    path: "/projects",
    router: projectRoutes,
    auth: true,
  }),
  ui: {
    tabs: [
      {
        id: "projects",
        label: "Projects",
        icon: "📋",
      },
    ],
    stats: [
      { id: "stat-projects", label: "projects", order: 5 },
    ],
  },
};
