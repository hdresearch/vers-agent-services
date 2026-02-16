import type { ServiceManifest } from "../types/manifest.js";
import { twilioRoutes } from "./routes.js";

export const manifest: ServiceManifest = {
  name: "twilio",
  description: "Twilio SMS webhook integration",
  dependencies: ["journal", "board", "log"],
  routes: () => ({
    path: "/twilio",
    router: twilioRoutes,
    auth: false, // Uses X-Twilio-Signature validation, not bearer auth
  }),
};
