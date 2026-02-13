import type { ServiceManifest } from "../types/manifest.js";
import { registryRoutes } from "./routes.js";

export const manifest: ServiceManifest = {
  name: "registry",
  description: "VM registry and heartbeat tracking",
  dependencies: [],
  routes: () => ({
    path: "/registry",
    router: registryRoutes,
    auth: true,
  }),
  ui: {
    widgets: [
      {
        id: "registry-panel",
        slot: "dashboard-right",
        order: 20,
      },
    ],
    stats: [
      { id: "stat-vms", label: "vms", order: 60 },
    ],
  },
};
