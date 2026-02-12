import Foundation
import Combine

/// Tracks token events in a sliding window and computes tok/s
@MainActor
final class TokenTracker: ObservableObject {
    struct TokenEvent {
        let timestamp: Date
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
    private var displayedRate: Double = 0
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
        lastEventTime = ts
        activeAgents.insert(agent)
        totalTokensToday += tokens
        estimatedCostToday += Double(tokens) * blendedCostPerToken
        pruneAndRecalculate()
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
            displayedRate = tokensPerSecond * decayFactor
            tokensPerSecond = displayedRate

            // Clear active agents if fully idle
            if displayedRate < 1.0 {
                activeAgents.removeAll()
            }
        }
    }

    private func pruneAndRecalculate() {
        let cutoff = Date().addingTimeInterval(-windowDuration)
        events.removeAll { $0.timestamp < cutoff }

        guard !events.isEmpty else {
            return
        }

        let totalTokensInWindow = events.reduce(0) { $0 + $1.tokens }
        let windowStart = events.first!.timestamp
        let windowEnd = events.last!.timestamp
        let duration = max(1.0, windowEnd.timeIntervalSince(windowStart))

        tokensPerSecond = Double(totalTokensInWindow) / duration
    }
}
