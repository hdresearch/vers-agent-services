/**
 * Protected Resources — maintain a list of VM IDs that can NEVER be deleted via API.
 * Born from the incident where an agent deleted our infra VM. Never again.
 */

import type { AegisStore, ProtectedResource } from "./store.js";

export class ProtectedGuard {
  constructor(private store: AegisStore) {}

  /**
   * Check if a VM is protected. This is the critical gate —
   * any delete operation should call this first.
   */
  isProtected(vmId: string): boolean {
    return this.store.isProtected(vmId);
  }

  /**
   * Attempt to delete a VM — returns false if protected.
   * Use this as a middleware check before any VM deletion.
   */
  canDelete(vmId: string): { allowed: boolean; reason?: string } {
    if (this.store.isProtected(vmId)) {
      this.store.audit("protected", "delete_blocked", `Blocked deletion of protected VM: ${vmId}`);
      return {
        allowed: false,
        reason: `VM ${vmId} is protected and cannot be deleted`,
      };
    }
    return { allowed: true };
  }

  /**
   * Add a protected resource.
   */
  add(vmId: string, label: string, reason: string, addedBy: string): ProtectedResource {
    return this.store.addProtectedResource(vmId, label, reason, addedBy);
  }

  /**
   * Remove a protected resource (requires explicit action).
   */
  remove(id: string): boolean {
    return this.store.removeProtectedResource(id);
  }

  /**
   * List all protected resources.
   */
  list(): ProtectedResource[] {
    return this.store.getProtectedResources();
  }
}
