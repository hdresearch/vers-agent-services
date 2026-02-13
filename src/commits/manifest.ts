import type { ServiceManifest } from "../types/manifest.js";
import { commitRoutes } from "./routes.js";

export const manifest: ServiceManifest = {
  name: "commits",
  description: "VM commit/snapshot tracking",
  dependencies: [],
  routes: () => ({
    path: "/commits",
    router: commitRoutes,
    auth: true,
  }),
  // No UI tabs — commits are API-only for now
};
