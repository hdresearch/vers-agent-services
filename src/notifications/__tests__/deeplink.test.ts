import { describe, it, expect, beforeEach } from "vitest";
import { createDeepLinkUrl, createDeepLinkedNotification } from "../deeplink.js";
import { notificationStore } from "../routes.js";

describe("notifications/deeplink", () => {
  beforeEach(() => {
    // Clear notifications by dismissing all
    notificationStore.dismissAll();
  });

  describe("createDeepLinkUrl", () => {
    it("generates a URL with token and redirect", () => {
      const url = createDeepLinkUrl("/ui/#comms", "https://infra.example.com");
      expect(url).toContain("https://infra.example.com/ui/login?token=");
      expect(url).toContain("&redirect=");
      expect(url).toContain(encodeURIComponent("/ui/#comms"));
    });

    it("uses fallback base URL when none provided", () => {
      const url = createDeepLinkUrl("/ui/#board");
      expect(url).toContain("/ui/login?token=");
      expect(url).toContain(encodeURIComponent("/ui/#board"));
    });

    it("generates unique tokens each time", () => {
      const url1 = createDeepLinkUrl("/ui/#comms");
      const url2 = createDeepLinkUrl("/ui/#comms");
      expect(url1).not.toBe(url2);
    });
  });

  describe("createDeepLinkedNotification", () => {
    it("creates a notification with a deep-link URL", () => {
      const notif = createDeepLinkedNotification({
        type: "chat",
        title: "New message",
        body: "Hello from fleet",
        priority: "normal",
        source: "fleet-chat",
        uiPath: "/ui/#comms",
      }, "https://infra.example.com");

      expect(notif.id).toBeTruthy();
      expect(notif.type).toBe("chat");
      expect(notif.title).toBe("New message");
      expect(notif.body).toBe("Hello from fleet");
      expect(notif.source).toBe("fleet-chat");
      expect(notif.url).toContain("/ui/login?token=");
      expect(notif.url).toContain(encodeURIComponent("/ui/#comms"));
      expect(notif.read).toBe(false);
      expect(notif.dismissed).toBe(false);
    });

    it("sets correct priority", () => {
      const notif = createDeepLinkedNotification({
        type: "alert",
        title: "Budget exceeded",
        body: "Agent blocked",
        priority: "critical",
        source: "aegis",
        uiPath: "/ui/v2",
      });

      expect(notif.priority).toBe("critical");
    });

    it("notification appears in pending list", () => {
      createDeepLinkedNotification({
        type: "update",
        title: "Sprint ready",
        body: "3 tasks planned",
        priority: "normal",
        source: "planner",
        uiPath: "/ui/pm",
      });

      const { notifications, pendingTotal } = notificationStore.getPending();
      const found = notifications.find((n) => n.title === "Sprint ready");
      expect(found).toBeTruthy();
      expect(found!.url).toContain("/ui/login?token=");
      expect(pendingTotal).toBeGreaterThanOrEqual(1);
    });

    it("supports various UI paths", () => {
      const paths = ["/ui/#comms", "/ui/#board", "/ui/#services", "/ui/pm", "/ui/v2"];
      for (const path of paths) {
        const notif = createDeepLinkedNotification({
          type: "custom",
          title: `Test ${path}`,
          body: "test",
          priority: "normal",
          source: "test",
          uiPath: path,
        });
        expect(notif.url).toContain(encodeURIComponent(path));
      }
    });
  });
});
