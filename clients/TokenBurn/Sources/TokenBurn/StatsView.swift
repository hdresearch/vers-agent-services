import SwiftUI

/// Compact stats row below the speedometer
struct StatsView: View {
    @ObservedObject var tracker: TokenTracker

    var body: some View {
        HStack(spacing: 16) {
            statItem(
                icon: "person.2.fill",
                label: "Agents",
                value: "\(tracker.activeAgents.count)"
            )

            Divider()
                .frame(height: 24)
                .background(Color(white: 0.3))

            statItem(
                icon: "number",
                label: "Tokens today",
                value: formatTokenCount(tracker.totalTokensToday)
            )

            Divider()
                .frame(height: 24)
                .background(Color(white: 0.3))

            statItem(
                icon: "dollarsign.circle",
                label: "Est. cost",
                value: formatCost(tracker.estimatedCostToday)
            )
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Color(white: 0.08))
        .cornerRadius(8)
    }

    private func statItem(icon: String, label: String, value: String) -> some View {
        VStack(spacing: 2) {
            Image(systemName: icon)
                .font(.system(size: 11))
                .foregroundColor(Color(white: 0.45))

            Text(value)
                .font(.system(size: 14, weight: .semibold, design: .monospaced))
                .foregroundColor(.white)

            Text(label)
                .font(.system(size: 9, weight: .medium))
                .foregroundColor(Color(white: 0.4))
        }
        .frame(minWidth: 60)
    }

    private func formatTokenCount(_ count: Int) -> String {
        if count < 1000 { return "\(count)" }
        if count < 1_000_000 {
            return String(format: "%.1fk", Double(count) / 1000.0)
        }
        return String(format: "%.2fM", Double(count) / 1_000_000.0)
    }

    private func formatCost(_ cost: Double) -> String {
        if cost < 0.01 { return "$0.00" }
        return String(format: "$%.2f", cost)
    }
}
