import Foundation
import Combine
import os

private let logger = Logger(subsystem: "com.tokenburn", category: "Tracker")

/// Tracks token events in a sliding window and computes tok/s
@MainActor
final class TokenTracker: ObservableObject {
    struct TokenEvent {
        let timestamp: Date      // always local Date(), never server timestamp
        let tokens: Int
        let agent: String
        let inputTokens: Int
        let outputTokens: Int
    }

    // MARK: - Published state
    @Published var tokensPerSecond: Double = 0
    @Published var activeAgents: Set<String> = []
    @Published var totalTokensToday: Int = 0
    @Published var estimatedCostToday: Double = 0

    // MARK: - Sliding window
    private var events: [TokenEvent] = []
    private let windowDuration: TimeInterval = 10.0
    private let decayAfter: TimeInterval = 5.0
    private var lastEventTime: Date = .distantPast
    private var timer: Timer?

    // Cost estimate: ~$3 per 1M input tokens, ~$15 per 1M output tokens (blended)
    private let blendedCostPerToken: Double = 6.0 / 1_000_000.0

    init() {
        startTimer()
    }

    func startTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.tick()
            }
        }
    }

    func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    func recordEvent(tokens: Int, agent: String, inputTokens: Int, outputTokens: Int, timestamp: Date? = nil) {
        let ts = timestamp ?? Date()
        let event = TokenEvent(
            timestamp: ts,
            tokens: tokens,
            agent: agent,
            inputTokens: inputTokens,
            outputTokens: outputTokens
        )
        events.append(event)
        lastEventTime = Date()  // Always use wall-clock for "last seen" tracking
        activeAgents.insert(agent)
        totalTokensToday += tokens
        estimatedCostToday += Double(tokens) * blendedCostPerToken

        logger.info("Tracker: recorded \(tokens) tok from \(agent), events in window: \(self.events.count)")
        pruneAndRecalculate()
        logger.info("Tracker: rate now \(self.tokensPerSecond, format: .fixed(precision: 1)) tok/s")
    }

    func loadSummary(totalTokens: Int, estimatedCost: Double) {
        self.totalTokensToday = totalTokens
        self.estimatedCostToday = estimatedCost
    }

    // MARK: - Private

    private func tick() {
        pruneAndRecalculate()

        // Decay toward 0 if no events recently
        let timeSinceLastEvent = Date().timeIntervalSince(lastEventTime)
        if timeSinceLastEvent > decayAfter {
            let decayFactor = max(0, 1.0 - (timeSinceLastEvent - decayAfter) / 5.0)
            let decayedRate = tokensPerSecond * decayFactor
            tokensPerSecond = decayedRate

            // Clear active agents if fully idle
            if decayedRate < 1.0 {
                activeAgents.removeAll()
            }
        }
    }

    private func pruneAndRecalculate() {
        let now = Date()
        let cutoff = now.addingTimeInterval(-windowDuration)
        events.removeAll { $0.timestamp < cutoff }

        guard !events.isEmpty else {
            return
        }

        let totalTokensInWindow = events.reduce(0) { $0 + $1.tokens }

        // Use wall-clock window duration (now - first event) instead of
        // event-to-event span. This matches the web speedometer's calculation
        // and produces a more accurate rate when events arrive in bursts.
        // The web version uses: totalTokens / max(0.5, (now - windowStart))
        let windowStart = events.first!.timestamp
        let duration = max(1.0, now.timeIntervalSince(windowStart))

        tokensPerSecond = Double(totalTokensInWindow) / duration
    }
}
