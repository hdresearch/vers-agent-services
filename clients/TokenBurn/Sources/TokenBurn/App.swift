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

        // Register UserDefaults defaults so auto-connect works on first launch.
        // @AppStorage defaults in SettingsView only apply within SwiftUI views —
        // they aren't visible to UserDefaults.standard.string(forKey:) which
        // MenuBarController.setup() uses for auto-connect.
        UserDefaults.standard.register(defaults: [
            "serverURL": "https://e0e2bf05-93fd-4a30-b4c6-4476b45beb16.vm.vers.sh:3000",
            "authToken": "fa2490f6cd1fa376b58bcb36ac66b2a0ec51b621cdb4e0e83c9a2c58342a082f",
        ])

        let controller = MenuBarController()
        controller.setup()
        self.menuBarController = controller
    }
}
