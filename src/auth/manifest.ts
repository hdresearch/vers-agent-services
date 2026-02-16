import type { ServiceManifest } from "../types/manifest.js";
import { keyRoutes } from "./key-routes.js";

export const manifest: ServiceManifest = {
  name: "auth",
  description: "API key management and authentication",
  dependencies: [],
  routes: () => ({
    path: "/auth",
    router: keyRoutes,
    auth: true,
  }),
};
