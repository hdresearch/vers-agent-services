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
///
/// ## Implementation notes
///
/// We use raw byte iteration (`for try await byte in bytes`) instead of
/// `bytes.lines` (AsyncLineSequence). This is critical because:
///
/// 1. `AsyncLineSequence` may not reliably yield empty strings for blank
///    lines (`\n\n`) on all macOS versions / URLSession configurations.
///    SSE relies on blank lines as event terminators — if they're swallowed,
///    `processEvent()` is never called and the needle never moves.
///
/// 2. Raw byte iteration gives us full control over line splitting, making
///    SSE parsing deterministic regardless of platform behavior.
///
/// The URLSession is stored as an instance property (not a local variable)
/// to prevent premature deallocation. A locally-scoped session can be GC'd
/// while the async byte iterator is suspended, silently canceling the
/// underlying data task even though `connectionState` stays `.connected`.
@MainActor
final class SSEClient: ObservableObject {
    enum ConnectionState: Equatable {
        case disconnected
        case connecting
        case connected
        case error(String)
    }

    @Published var connectionState: ConnectionState = .disconnected
    /// Diagnostic: total SSE lines received (visible in Console.app)
    @Published var linesReceived: Int = 0
    /// Diagnostic: total events processed
    @Published var eventsProcessed: Int = 0

    private var streamTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private let tracker: TokenTracker
    private var serverURL: String = ""
    private var authToken: String = ""

    /// Retained to prevent deallocation while stream is active.
    /// URLSession created as a local variable can be GC'd when the async
    /// iterator suspends, silently killing the data task underneath.
    private var activeSession: URLSession?

    init(tracker: TokenTracker) {
        self.tracker = tracker
    }

    func connect(serverURL: String, authToken: String) {
        self.serverURL = serverURL
        self.authToken = authToken
        disconnect()
        connectionState = .connecting
        linesReceived = 0
        eventsProcessed = 0
        streamTask = Task { [weak self] in
            await self?.runStream()
        }
    }

    func disconnect() {
        streamTask?.cancel()
        streamTask = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        activeSession?.invalidateAndCancel()
        activeSession = nil
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
            logger.warning("Failed to fetch summary: \(error.localizedDescription)")
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
            // CRITICAL: retain session as instance property. Without this,
            // the session (a local variable) can be deallocated while the
            // async byte iterator is suspended. URLSession deallocation
            // cancels all tasks — silently killing the SSE stream while
            // connectionState still shows .connected.
            self.activeSession = session

            logger.info("SSE: connecting to \(urlString)")
            let (bytes, response) = try await session.bytes(for: request)

            if let httpResponse = response as? HTTPURLResponse {
                let status = httpResponse.statusCode
                logger.info("SSE: HTTP \(status), headers: \(httpResponse.allHeaderFields.keys.map { String(describing: $0) }.joined(separator: ", "))")
                if status != 200 {
                    connectionState = .error("HTTP \(status)")
                    scheduleReconnect()
                    return
                }
            }

            connectionState = .connected
            logger.info("SSE: stream connected ✓")

            // ─── Manual line-based SSE parser ───
            // We iterate raw bytes instead of using `bytes.lines` because
            // AsyncLineSequence may not reliably yield empty strings for
            // blank lines (\n\n) — which SSE requires as event terminators.
            // Without empty-line yields, processEvent() is never called.

            var lineBuffer = Data()
            var currentEvent = ""
            var currentData = ""

            for try await byte in bytes {
                if Task.isCancelled { break }

                if byte == UInt8(ascii: "\n") {
                    // End of line — convert buffer to string
                    let line = String(data: lineBuffer, encoding: .utf8) ?? ""
                    lineBuffer.removeAll(keepingCapacity: true)

                    linesReceived += 1

                    if line.isEmpty {
                        // ── Blank line = end of SSE event ──
                        if !currentData.isEmpty {
                            logger.debug("SSE: dispatching event (type='\(currentEvent)', data=\(currentData.prefix(80))...)")
                            processEvent(type: currentEvent, data: currentData)
                            eventsProcessed += 1
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
                        // SSE comment / keepalive — log but ignore
                        logger.debug("SSE: heartbeat/comment")
                    } else {
                        logger.debug("SSE: unknown line: \(line.prefix(60))")
                    }
                } else if byte != UInt8(ascii: "\r") {
                    // Accumulate non-CR, non-LF bytes into the line buffer.
                    // (SSE lines are separated by \n, \r\n, or \r — we strip \r)
                    lineBuffer.append(byte)
                }
            }

            // Stream ended normally
            if !Task.isCancelled {
                connectionState = .disconnected
                logger.info("SSE: stream ended normally, scheduling reconnect")
                scheduleReconnect()
            }
        } catch {
            if !Task.isCancelled {
                connectionState = .error(error.localizedDescription)
                logger.error("SSE: stream error: \(error.localizedDescription)")
                scheduleReconnect()
            }
        }
    }

    private func processEvent(type: String, data: String) {
        // Parse the outer event JSON
        guard let jsonData = data.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else {
            logger.warning("SSE: failed to parse event JSON: \(data.prefix(200))")
            return
        }

        // The event type lives inside the JSON `type` field (NOT in the SSE event: field,
        // which the server doesn't send). Fall back to SSE event type if present.
        let eventType = json["type"] as? String ?? type
        logger.info("SSE: event type=\(eventType), id=\(json["id"] as? String ?? "?")")

        guard eventType == "cost_update" || eventType == "token_update" else {
            // Not a token event — ignore (agent_started, task_completed, etc.)
            logger.debug("SSE: ignoring non-token event type '\(eventType)'")
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
            logger.warning("SSE: \(eventType) event missing parseable detail. Raw: \(data.prefix(200))")
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
            logger.info("SSE: ✅ recording \(tokens) tokens from \(agent) (in=\(inputTokens), out=\(outputTokens))")
            tracker.recordEvent(
                tokens: tokens,
                agent: agent,
                inputTokens: inputTokens,
                outputTokens: outputTokens
            )
        } else {
            logger.info("SSE: ⚠️ \(eventType) event from \(agent) had 0 tokensThisTurn — detail keys: \(detail.keys.sorted().joined(separator: ", "))")
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
