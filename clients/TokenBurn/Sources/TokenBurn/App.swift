import SwiftUI
import AppKit

@main
struct TokenBurnApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        // Menu bar apps don't need a window scene, but SwiftUI requires at least one.
        // We use Settings as a no-op scene.
        Settings {
            EmptyView()
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    var menuBarController: MenuBarController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Hide dock icon — this is a menu bar only app
        NSApp.setActivationPolicy(.accessory)

        let controller = MenuBarController()
        controller.setup()
        self.menuBarController = controller
    }
}
