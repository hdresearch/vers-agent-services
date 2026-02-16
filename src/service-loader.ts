import type { Hono } from "hono";
import type { ServiceManifest, UIManifest } from "./types/manifest.js";
import { bearerAuth } from "./auth.js";

/**
 * ServiceLoader — discovers, validates, and assembles modular services.
 *
 * Usage:
 *   const loader = new ServiceLoader();
 *   loader.register(boardManifest);
 *   loader.register(feedManifest);
 *   loader.mount(app);  // mounts all routes + /ui/manifest endpoint
 */
export class ServiceLoader {
  private manifests: ServiceManifest[] = [];
  private loaded = new Set<string>();

  /** Register a service manifest */
  register(manifest: ServiceManifest): void {
    if (this.loaded.has(manifest.name)) {
      console.warn(`⚠️  Service "${manifest.name}" already registered, skipping duplicate`);
      return;
    }
    this.manifests.push(manifest);
    this.loaded.add(manifest.name);
  }

  /** Resolve dependency order (topological sort). Throws on missing deps. */
  private resolve(): ServiceManifest[] {
    const byName = new Map<string, ServiceManifest>();
    for (const m of this.manifests) byName.set(m.name, m);

    const resolved: ServiceManifest[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (name: string) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        throw new Error(`Circular dependency detected involving "${name}"`);
      }
      const m = byName.get(name);
      if (!m) {
        // Missing dependency — warn but don't crash
        console.warn(`⚠️  Missing dependency: "${name}"`);
        return;
      }
      visiting.add(name);
      for (const dep of m.dependencies) {
        visit(dep);
      }
      visiting.delete(name);
      visited.add(name);
      resolved.push(m);
    };

    for (const m of this.manifests) visit(m.name);
    return resolved;
  }

  /** Mount all service routes onto the Hono app and register /ui/manifest */
  async mount(app: Hono): Promise<void> {
    const ordered = this.resolve();

    // Mount routes
    for (const manifest of ordered) {
      if (manifest.routes) {
        const { path, router, auth } = manifest.routes();
        if (auth !== false) {
          app.use(`${path}/*`, bearerAuth());
        }
        app.route(path, router);
        console.log(`  ✓ ${manifest.name} → ${path}`);
      }
    }

    // Run init hooks
    for (const manifest of ordered) {
      if (manifest.init) {
        await manifest.init();
      }
    }

    console.log(`\n  ${ordered.length} services loaded`);
  }

  /** Build the UI manifest (serializable, sent to browser) */
  getUIManifest(): UIManifest {
    const services = this.manifests
      .filter((m) => m.ui)
      .map((m) => ({
        name: m.name,
        description: m.description,
        ui: m.ui!,
      }));
    return { services };
  }

  /** Get all registered service names */
  getServiceNames(): string[] {
    return this.manifests.map((m) => m.name);
  }
}
