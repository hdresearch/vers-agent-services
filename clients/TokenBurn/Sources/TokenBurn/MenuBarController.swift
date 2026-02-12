import AppKit
import SwiftUI
import Combine

/// Manages the NSStatusItem and popover
@MainActor
final class MenuBarController: NSObject, ObservableObject {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private var cancellables = Set<AnyCancellable>()
    private var eventMonitor: Any?

    let tracker: TokenTracker
    let sseClient: SSEClient

    override init() {
        self.tracker = TokenTracker()
        self.sseClient = SSEClient(tracker: tracker)
        super.init()
    }

    func setup() {
        // Create status item
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)

        if let button = statusItem.button {
            button.title = "⚡ 0"
            button.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .medium)
            button.action = #selector(togglePopover)
            button.target = self
        }

        // Create popover with content
        popover = NSPopover()
        popover.contentSize = NSSize(width: 300, height: 380)
        popover.behavior = .transient
        popover.animates = true

        let contentView = PopoverContentView(
            tracker: tracker,
            sseClient: sseClient,
            onConnect: { [weak self] url, token in
                self?.connectToServer(url: url, token: token)
            },
            onQuit: {
                NSApplication.shared.terminate(nil)
            }
        )
        popover.contentViewController = NSHostingController(rootView: contentView)

        // Monitor clicks outside popover to close it
        eventMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            self?.closePopover()
        }

        // Subscribe to tracker changes to update menu bar text
        tracker.$tokensPerSecond
            .receive(on: RunLoop.main)
            .sink { [weak self] rate in
                self?.updateMenuBarText(rate: rate)
            }
            .store(in: &cancellables)

        // Auto-connect with saved credentials
        let url = UserDefaults.standard.string(forKey: "serverURL") ?? ""
        let token = UserDefaults.standard.string(forKey: "authToken") ?? ""
        if !url.isEmpty && !token.isEmpty {
            connectToServer(url: url, token: token)
        }
    }

    private func connectToServer(url: String, token: String) {
        sseClient.connect(serverURL: url, authToken: token)
        Task {
            await sseClient.fetchSummary()
        }
    }

    private func updateMenuBarText(rate: Double) {
        guard let button = statusItem.button else { return }

        let text: String
        if rate < 1 {
            text = "⚡ 0"
        } else if rate < 1000 {
            text = String(format: "⚡ %.0f", rate)
        } else {
            text = String(format: "⚡ %.1fk", rate / 1000.0)
        }

        // Use attributed string for the lightning bolt color hint
        let attributed = NSMutableAttributedString(string: text)
        attributed.addAttribute(.font,
                              value: NSFont.monospacedSystemFont(ofSize: 12, weight: .medium),
                              range: NSRange(location: 0, length: text.count))
        button.attributedTitle = attributed
    }

    @objc private func togglePopover() {
        if popover.isShown {
            closePopover()
        } else {
            if let button = statusItem.button {
                popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
                // Ensure popover window is key
                popover.contentViewController?.view.window?.makeKey()
            }
        }
    }

    private func closePopover() {
        if popover.isShown {
            popover.performClose(nil)
        }
    }

    deinit {
        if let monitor = eventMonitor {
            NSEvent.removeMonitor(monitor)
        }
    }
}

// MARK: - Popover Content

struct PopoverContentView: View {
    @ObservedObject var tracker: TokenTracker
    @ObservedObject var sseClient: SSEClient
    var onConnect: (String, String) -> Void
    var onQuit: () -> Void

    @State private var showSettings = false

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Text("Token Burn")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundColor(.white)
                Spacer()
                // Connection indicator
                Circle()
                    .fill(sseClient.connectionState == .connected ? Color.green : Color.red)
                    .frame(width: 6, height: 6)
                    .shadow(color: (sseClient.connectionState == .connected ? Color.green : Color.red).opacity(0.6), radius: 3)

                Button(action: { showSettings.toggle() }) {
                    Image(systemName: "gear")
                        .font(.system(size: 12))
                        .foregroundColor(Color(white: 0.5))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 4)

            // Speedometer
            SpeedometerView(tokensPerSecond: tracker.tokensPerSecond)
                .padding(.horizontal, 16)
                .padding(.top, 4)

            Spacer().frame(height: 12)

            // Stats
            StatsView(tracker: tracker)
                .padding(.horizontal, 12)

            // Settings (collapsible)
            if showSettings {
                SettingsView(sseClient: sseClient, onConnect: onConnect)
                    .padding(.horizontal, 12)
                    .padding(.top, 8)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }

            Spacer().frame(height: 8)

            // Footer
            HStack {
                Spacer()
                Button(action: onQuit) {
                    Text("Quit")
                        .font(.system(size: 10))
                        .foregroundColor(Color(white: 0.35))
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
        }
        .frame(width: 300)
        .background(Color(nsColor: NSColor(white: 0.05, alpha: 1.0)))
    }
}
