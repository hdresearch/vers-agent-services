import type { ServiceManifest } from "../types/manifest.js";
import { logRoutes } from "./routes.js";

export const manifest: ServiceManifest = {
  name: "log",
  description: "Append-only agent activity log",
  dependencies: [],
  routes: () => ({
    path: "/log",
    router: logRoutes,
    auth: true,
  }),
  ui: {
    tabs: [
      {
        id: "log",
        label: "Log",
        icon: "📋",
        scriptUrl: "/ui/static/tabs/log.js",
      },
    ],
  },
};
