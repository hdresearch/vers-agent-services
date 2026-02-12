import SwiftUI

/// Configuration view for server URL and auth token
struct SettingsView: View {
    @AppStorage("serverURL") private var serverURL: String = "https://e0e2bf05-93fd-4a30-b4c6-4476b45beb16.vm.vers.sh:3000"
    @AppStorage("authToken") private var authToken: String = "fa2490f6cd1fa376b58bcb36ac66b2a0ec51b621cdb4e0e83c9a2c58342a082f"

    @ObservedObject var sseClient: SSEClient
    var onConnect: (String, String) -> Void

    @State private var editingURL: String = ""
    @State private var editingToken: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header
            HStack {
                Image(systemName: "gear")
                    .foregroundColor(Color(white: 0.5))
                Text("Settings")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.white)
                Spacer()
                connectionDot
            }

            // Server URL
            VStack(alignment: .leading, spacing: 4) {
                Text("Server URL")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(Color(white: 0.45))
                TextField("https://...", text: $editingURL)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundColor(.white)
                    .padding(6)
                    .background(Color(white: 0.1))
                    .cornerRadius(4)
                    .overlay(
                        RoundedRectangle(cornerRadius: 4)
                            .stroke(Color(white: 0.2), lineWidth: 1)
                    )
            }

            // Auth token
            VStack(alignment: .leading, spacing: 4) {
                Text("Auth Token")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(Color(white: 0.45))
                SecureField("Bearer token", text: $editingToken)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundColor(.white)
                    .padding(6)
                    .background(Color(white: 0.1))
                    .cornerRadius(4)
                    .overlay(
                        RoundedRectangle(cornerRadius: 4)
                            .stroke(Color(white: 0.2), lineWidth: 1)
                    )
            }

            // Save button
            HStack {
                Spacer()
                Button(action: save) {
                    Text("Save & Connect")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 6)
                        .background(Color.accentColor.opacity(0.8))
                        .cornerRadius(6)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(12)
        .background(Color(white: 0.06))
        .cornerRadius(8)
        .onAppear {
            editingURL = serverURL
            editingToken = authToken
        }
    }

    private var connectionDot: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(connectionColor)
                .frame(width: 8, height: 8)
                .shadow(color: connectionColor.opacity(0.6), radius: 3)
            Text(connectionLabel)
                .font(.system(size: 10))
                .foregroundColor(Color(white: 0.5))
        }
    }

    private var connectionColor: Color {
        switch sseClient.connectionState {
        case .connected: return .green
        case .connecting: return .yellow
        case .disconnected: return Color(white: 0.3)
        case .error: return .red
        }
    }

    private var connectionLabel: String {
        switch sseClient.connectionState {
        case .connected: return "Connected"
        case .connecting: return "Connecting..."
        case .disconnected: return "Disconnected"
        case .error(let msg): return "Error: \(msg.prefix(20))"
        }
    }

    private func save() {
        serverURL = editingURL
        authToken = editingToken
        onConnect(editingURL, editingToken)
    }
}
