import Foundation
import Combine

/// Server-Sent Events client using URLSession async bytes streaming
@MainActor
final class SSEClient: ObservableObject {
    enum ConnectionState: Equatable {
        case disconnected
        case connecting
        case connected
        case error(String)
    }

    @Published var connectionState: ConnectionState = .disconnected

    private var streamTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private let tracker: TokenTracker
    private var serverURL: String = ""
    private var authToken: String = ""

    init(tracker: TokenTracker) {
        self.tracker = tracker
    }

    func connect(serverURL: String, authToken: String) {
        self.serverURL = serverURL
        self.authToken = authToken
        disconnect()
        connectionState = .connecting
        streamTask = Task { [weak self] in
            await self?.runStream()
        }
    }

    func disconnect() {
        streamTask?.cancel()
        streamTask = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        connectionState = .disconnected
    }

    func fetchSummary() async {
        guard !serverURL.isEmpty, !authToken.isEmpty else { return }
        let urlString = "\(serverURL)/usage/summary?range=1d"
        guard let url = URL(string: urlString) else { return }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")

        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                let totalTokens = json["totalTokens"] as? Int ?? 0
                let totalCost = json["totalCost"] as? Double ?? 0
                tracker.loadSummary(totalTokens: totalTokens, estimatedCost: totalCost)
            }
        } catch {
            // Non-fatal — summary is supplementary
        }
    }

    // MARK: - SSE Stream

    private func runStream() async {
        let urlString = "\(serverURL)/feed/stream"
        guard let url = URL(string: urlString) else {
            connectionState = .error("Invalid URL")
            return
        }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        // Keep-alive: no timeout
        request.timeoutInterval = .infinity

        do {
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 300
            config.timeoutIntervalForResource = .infinity
            let session = URLSession(configuration: config)

            let (bytes, response) = try await session.bytes(for: request)

            if let httpResponse = response as? HTTPURLResponse,
               httpResponse.statusCode != 200 {
                connectionState = .error("HTTP \(httpResponse.statusCode)")
                scheduleReconnect()
                return
            }

            connectionState = .connected

            var currentEvent = ""
            var currentData = ""

            for try await line in bytes.lines {
                if Task.isCancelled { break }

                if line.isEmpty {
                    // End of event — process it
                    if !currentData.isEmpty {
                        processEvent(type: currentEvent, data: currentData)
                    }
                    currentEvent = ""
                    currentData = ""
                } else if line.hasPrefix("event:") {
                    currentEvent = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
                } else if line.hasPrefix("data:") {
                    let data = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                    if currentData.isEmpty {
                        currentData = data
                    } else {
                        currentData += "\n" + data
                    }
                } else if line.hasPrefix(":") {
                    // SSE comment/keepalive — ignore
                }
            }

            // Stream ended normally
            if !Task.isCancelled {
                connectionState = .disconnected
                scheduleReconnect()
            }
        } catch {
            if !Task.isCancelled {
                connectionState = .error(error.localizedDescription)
                scheduleReconnect()
            }
        }
    }

    private func processEvent(type: String, data: String) {
        // Parse the outer event JSON
        guard let jsonData = data.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else {
            return
        }

        // We're interested in cost_update events (which carry token data)
        // and also token_update if the feed uses that type
        let eventType = json["type"] as? String ?? type

        // Parse the detail field (it's a JSON string inside the event)
        guard let detailString = json["detail"] as? String,
              let detailData = detailString.data(using: .utf8),
              let detail = try? JSONSerialization.jsonObject(with: detailData) as? [String: Any] else {
            // Some events might not have detail — that's fine
            return
        }

        if eventType == "cost_update" || eventType == "token_update" {
            let tokens = detail["tokensThisTurn"] as? Int ?? 0
            let agent = detail["agent"] as? String ?? json["agent"] as? String ?? "unknown"
            let inputTokens = detail["inputTokens"] as? Int ?? 0
            let outputTokens = detail["outputTokens"] as? Int ?? 0
            let timestampMs = detail["timestamp"] as? Double
            let ts: Date? = timestampMs.map { Date(timeIntervalSince1970: $0 / 1000.0) }

            if tokens > 0 {
                tracker.recordEvent(
                    tokens: tokens,
                    agent: agent,
                    inputTokens: inputTokens,
                    outputTokens: outputTokens,
                    timestamp: ts
                )
            }
        }
    }

    private func scheduleReconnect() {
        reconnectTask?.cancel()
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 3_000_000_000) // 3 seconds
            guard !Task.isCancelled else { return }
            self?.reconnect()
        }
    }

    private func reconnect() {
        guard !serverURL.isEmpty, !authToken.isEmpty else { return }
        connect(serverURL: serverURL, authToken: authToken)
    }
}
