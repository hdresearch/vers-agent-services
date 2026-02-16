import type { ServiceManifest } from "../types/manifest.js";
import { journalRoutes } from "./routes.js";

export const manifest: ServiceManifest = {
  name: "journal",
  description: "Structured agent journal with mood, tags, and author filtering",
  dependencies: [],
  routes: () => ({
    path: "/journal",
    router: journalRoutes,
    auth: true,
  }),
  ui: {
    tabs: [
      {
        id: "journal",
        label: "Journal",
        icon: "📓",
        scriptUrl: "/ui/static/tabs/journal.js",
      },
    ],
  },
};
