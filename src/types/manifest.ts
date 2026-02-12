import type { Hono } from "hono";

/**
 * Service Manifest — the contract every modular service implements.
 *
 * Each service directory contains a `manifest.ts` that exports a `manifest`
 * conforming to this type. The service loader discovers and assembles them
 * at startup.
 */

/** A tab rendered in the top navigation bar */
export interface UITab {
  /** Unique tab identifier — used as DOM id and route key */
  id: string;
  /** Human-readable label shown in the tab bar */
  label: string;
  /** Emoji or icon string */
  icon: string;
  /** URL to the JS file that registers this tab's behavior */
  scriptUrl?: string;
}

/** A widget injected into a named slot (e.g. dashboard panels) */
export interface UIWidget {
  /** Unique widget identifier */
  id: string;
  /** Slot name — where to inject (e.g. "dashboard-left", "dashboard-right", "stats-bar") */
  slot: string;
  /** Optional ordering weight (lower = first, default 50) */
  order?: number;
  /** URL to the JS file that registers this widget's behavior */
  scriptUrl?: string;
}

/** Stats bar counter definition */
export interface UIStat {
  /** Unique stat id — becomes the DOM element id */
  id: string;
  /** Label displayed above the value */
  label: string;
  /** Ordering weight (lower = first) */
  order?: number;
}

export interface ServiceUI {
  /** Tabs this service contributes to the nav bar */
  tabs?: UITab[];
  /** Widgets this service injects into layout slots */
  widgets?: UIWidget[];
  /** Stats bar entries */
  stats?: UIStat[];
  /** Additional static script URLs to load (e.g. metrics.js) */
  scripts?: string[];
  /** Raw HTML to inject into the tab's view container */
  viewHtml?: string;
}

export interface ServiceManifest {
  /** Unique service name (e.g. "board", "feed") */
  name: string;
  /** Human-readable description */
  description: string;
  /** Names of other services this depends on (for load ordering) */
  dependencies: string[];
  /** Function that returns Hono routes + the base path to mount them at */
  routes?: () => { path: string; router: Hono; auth?: boolean };
  /** UI contributions */
  ui?: ServiceUI;
  /** Optional initialization hook (called after all services are registered) */
  init?: () => void | Promise<void>;
}

/**
 * The resolved manifest served to the browser at GET /ui/manifest.
 * Contains only serializable UI metadata — no functions.
 */
export interface UIManifest {
  services: Array<{
    name: string;
    description: string;
    ui: ServiceUI;
  }>;
}
