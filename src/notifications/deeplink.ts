/**
 * Deep-linked notifications — creates notifications with authenticated URLs.
 *
 * Generates a magic link that drops the user straight into the relevant
 * UI tab when clicked. No second login step.
 */

import { createMagicLink } from "../ui/auth.js";
import { notificationStore } from "./routes.js";

export interface DeepLinkedNotificationOpts {
  type: string;
  title: string;
  body: string;
  priority: string;
  source: string;
  uiPath: string; // e.g. "/ui/#comms", "/ui/pm", "/ui/v2"
}

/**
 * Build an authenticated deep-link URL for a given UI path.
 * The magic link token is consumed on first use, creating a session
 * and redirecting to the target path.
 */
export function createDeepLinkUrl(uiPath: string, baseUrl?: string): string {
  const link = createMagicLink();
  const base = baseUrl || process.env.VERS_INFRA_URL || "http://localhost:3000";
  // Encode the redirect target so the login page can forward after session creation
  const redirect = encodeURIComponent(uiPath);
  return `${base}/ui/login?token=${link.token}&redirect=${redirect}`;
}

/**
 * Create a notification with an authenticated deep-link URL.
 * The `url` field in the notification will be a one-time magic link
 * that logs the user in and redirects to `uiPath`.
 */
export function createDeepLinkedNotification(opts: DeepLinkedNotificationOpts, baseUrl?: string) {
  const url = createDeepLinkUrl(opts.uiPath, baseUrl);
  return notificationStore.create({
    type: opts.type,
    title: opts.title,
    body: opts.body,
    priority: opts.priority,
    source: opts.source,
    url,
  });
}
