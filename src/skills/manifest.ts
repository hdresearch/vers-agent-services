import type { ServiceManifest } from "../types/manifest.js";
import { skillsRoutes } from "./routes.js";

export const manifest: ServiceManifest = {
  name: "skills",
  description: "Skill registry, extensions, and agent sync",
  dependencies: [],
  routes: () => ({
    path: "/skills",
    router: skillsRoutes,
    auth: true,
  }),
  ui: {
    tabs: [
      {
        id: "skills",
        label: "Skills",
        icon: "⚡",
        scriptUrl: "/ui/static/tabs/skills.js",
      },
    ],
  },
};
