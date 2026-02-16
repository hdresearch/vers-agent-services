import type { ServiceManifest } from "../types/manifest.js";
import { configRoutes } from "./routes.js";

export const manifest: ServiceManifest = {
  name: "config",
  description: "Configuration management for agent services",
  dependencies: [],
  routes: () => ({
    path: "/config",
    router: configRoutes,
    auth: true,
  }),
};
