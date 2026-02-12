import Foundation
import Combine
import os

private let logger = Logger(subsystem: "com.tokenburn", category: "SSE")

/// Server-Sent Events client using URLSession async bytes streaming
///
/// The server sends SSE frames as:
///   data: {"id":"...","type":"token_update","detail":"{...}"}\n\n
///
/// Note: server does NOT send an `event:` field — the event type lives
/// inside the JSON data payload under the `type` key. The `detail` field
/// is a JSON-encoded string that must be double-parsed.
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
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        // Keep-alive: no timeout
        request.timeoutInterval = .infinity

        do {
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 300
            config.timeoutIntervalForResource = .infinity
            // Disable caching — SSE streams must never be cached
            config.requestCachePolicy = .reloadIgnoringLocalCacheData
            config.urlCache = nil
            let session = URLSession(configuration: config)

            let (bytes, response) = try await session.bytes(for: request)

            if let httpResponse = response as? HTTPURLResponse,
               httpResponse.statusCode != 200 {
                connectionState = .error("HTTP \(httpResponse.statusCode)")
                logger.error("SSE stream returned HTTP \(httpResponse.statusCode)")
                scheduleReconnect()
                return
            }

            connectionState = .connected
            logger.info("SSE stream connected to \(urlString)")

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
                logger.info("SSE stream ended normally, reconnecting")
                scheduleReconnect()
            }
        } catch {
            if !Task.isCancelled {
                connectionState = .error(error.localizedDescription)
                logger.error("SSE stream error: \(error.localizedDescription)")
                scheduleReconnect()
            }
        }
    }

    private func processEvent(type: String, data: String) {
        // Parse the outer event JSON
        guard let jsonData = data.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else {
            logger.warning("SSE: failed to parse event JSON: \(data.prefix(100))")
            return
        }

        // The event type lives inside the JSON `type` field (NOT in the SSE event: field,
        // which the server doesn't send). Fall back to SSE event type if present.
        let eventType = json["type"] as? String ?? type

        guard eventType == "cost_update" || eventType == "token_update" else {
            // Not a token event — ignore (agent_started, task_completed, etc.)
            return
        }

        // Parse the detail field — it's a JSON string that needs double-parsing.
        // The extension sends: detail: JSON.stringify({ tokensThisTurn, ... })
        // so the outer JSON has detail as a string, not an object.
        let detail: [String: Any]
        if let detailString = json["detail"] as? String,
           let detailData = detailString.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: detailData) as? [String: Any] {
            detail = parsed
        } else if let detailDict = json["detail"] as? [String: Any] {
            // Fallback: detail might already be a dictionary (if server changes format)
            detail = detailDict
        } else {
            logger.warning("SSE: \(eventType) event missing parseable detail")
            return
        }

        // Use NSNumber bridging for robust numeric extraction — JSONSerialization
        // returns NSNumber which may be Int64, Double, etc. depending on magnitude
        let tokens = (detail["tokensThisTurn"] as? NSNumber)?.intValue ?? 0
        let agent = detail["agent"] as? String ?? json["agent"] as? String ?? "unknown"
        let inputTokens = (detail["inputTokens"] as? NSNumber)?.intValue ?? 0
        let outputTokens = (detail["outputTokens"] as? NSNumber)?.intValue ?? 0

        // Always use local time (Date()) for the sliding window timestamp.
        // The server's detail.timestamp comes from the Vers VM clock which may
        // have skew relative to this Mac. Using a stale server timestamp causes
        // events to fall outside the 10-second window and get pruned on arrival,
        // resulting in tokensPerSecond permanently stuck at 0.

        if tokens > 0 {
            logger.info("SSE: recording \(tokens) tokens from \(agent) (input=\(inputTokens), output=\(outputTokens))")
            tracker.recordEvent(
                tokens: tokens,
                agent: agent,
                inputTokens: inputTokens,
                outputTokens: outputTokens
            )
        } else {
            logger.debug("SSE: \(eventType) event from \(agent) had 0 tokens, skipping")
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
