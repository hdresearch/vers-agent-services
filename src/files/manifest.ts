import type { ServiceManifest } from "../types/manifest.js";
import { fileRoutes, filePublicRoutes } from "./routes.js";

export const manifest: ServiceManifest = {
  name: "files",
  description: "Agent file sharing — upload, download, share files between agents",
  dependencies: [],
  routes: () => ({
    path: "/files",
    router: fileRoutes,
    auth: true,
  }),
  ui: {
    widgets: [
      {
        id: "file-drop",
        slot: "sidebar",
      },
    ],
  },
};
