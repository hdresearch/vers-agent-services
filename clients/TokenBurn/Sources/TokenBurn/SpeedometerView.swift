import SwiftUI

/// Semicircular speedometer gauge drawn with Canvas
struct SpeedometerView: View {
    let tokensPerSecond: Double
    let maxValue: Double = 5000

    // Animated needle position
    @State private var animatedValue: Double = 0
    // Glow pulse
    @State private var glowPhase: Double = 0

    var body: some View {
        VStack(spacing: 8) {
            // Gauge
            ZStack {
                // The canvas-drawn gauge
                Canvas { context, size in
                    drawGauge(context: context, size: size)
                }
                .frame(width: 260, height: 160)

                // Needle overlay (using SwiftUI for spring animation)
                needleView
                    .frame(width: 260, height: 160)

                // Center cap
                Circle()
                    .fill(
                        RadialGradient(
                            colors: [Color(white: 0.4), Color(white: 0.15)],
                            center: .center,
                            startRadius: 0,
                            endRadius: 12
                        )
                    )
                    .frame(width: 20, height: 20)
                    .offset(y: 40)
            }

            // Digital readout
            digitalReadout
        }
        .onChange(of: tokensPerSecond) { newValue in
            withAnimation(.spring(response: 0.6, dampingFraction: 0.65, blendDuration: 0.1)) {
                animatedValue = min(newValue, maxValue)
            }
        }
        .onAppear {
            animatedValue = min(tokensPerSecond, maxValue)
            // Start glow animation
            withAnimation(.easeInOut(duration: 2.0).repeatForever(autoreverses: true)) {
                glowPhase = 1.0
            }
        }
    }

    // MARK: - Needle

    private var needleView: some View {
        GeometryReader { geo in
            let center = CGPoint(x: geo.size.width / 2, y: geo.size.height - 20)
            let radius: CGFloat = 100
            let fraction = animatedValue / maxValue
            // Angle: from 180° (left) to 0° (right) — maps to π to 0
            let angle = Angle.degrees(180 - fraction * 180)

            Path { path in
                let tipX = center.x + radius * CGFloat(cos(angle.radians))
                let tipY = center.y - radius * CGFloat(sin(angle.radians))

                // Needle base width
                let perpAngle = angle.radians + .pi / 2
                let baseOffset: CGFloat = 3
                let baseX1 = center.x + baseOffset * CGFloat(cos(perpAngle))
                let baseY1 = center.y - baseOffset * CGFloat(sin(perpAngle))
                let baseX2 = center.x - baseOffset * CGFloat(cos(perpAngle))
                let baseY2 = center.y + baseOffset * CGFloat(sin(perpAngle))

                path.move(to: CGPoint(x: baseX1, y: baseY1))
                path.addLine(to: CGPoint(x: tipX, y: tipY))
                path.addLine(to: CGPoint(x: baseX2, y: baseY2))
                path.closeSubpath()
            }
            .fill(needleColor)
            .shadow(color: needleGlowColor.opacity(0.6 + 0.4 * glowPhase), radius: 6)
        }
    }

    private var needleColor: Color {
        let fraction = animatedValue / maxValue
        if fraction < 0.25 { return .green }
        if fraction < 0.5 { return .yellow }
        if fraction < 0.75 { return .orange }
        return .red
    }

    private var needleGlowColor: Color {
        let fraction = animatedValue / maxValue
        if fraction < 0.25 { return .green }
        if fraction < 0.5 { return .yellow }
        if fraction < 0.75 { return .orange }
        return .red
    }

    // MARK: - Digital Readout

    private var digitalReadout: some View {
        HStack(spacing: 4) {
            Text(formattedRate)
                .font(.system(size: 32, weight: .bold, design: .monospaced))
                .foregroundStyle(
                    LinearGradient(
                        colors: [.white, Color(white: 0.7)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
            Text("tok/s")
                .font(.system(size: 14, weight: .medium, design: .monospaced))
                .foregroundColor(Color(white: 0.5))
                .offset(y: 4)
        }
        .shadow(color: needleGlowColor.opacity(0.3 + 0.2 * glowPhase), radius: 8)
    }

    private var formattedRate: String {
        let val = animatedValue
        if val < 1 { return "0" }
        if val < 1000 { return String(format: "%.0f", val) }
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = 0
        return formatter.string(from: NSNumber(value: val)) ?? "\(Int(val))"
    }

    // MARK: - Canvas Drawing

    private func drawGauge(context: GraphicsContext, size: CGSize) {
        let center = CGPoint(x: size.width / 2, y: size.height - 20)
        let outerRadius: CGFloat = 115
        let innerRadius: CGFloat = 90
        let tickOuterRadius: CGFloat = 118

        // Background arc
        let bgArcPath = Path { path in
            path.addArc(center: center, radius: (outerRadius + innerRadius) / 2,
                       startAngle: .degrees(180), endAngle: .degrees(0),
                       clockwise: false)
        }
        context.stroke(bgArcPath, with: .color(Color(white: 0.15)), lineWidth: outerRadius - innerRadius)

        // Gradient arc (colored portion up to current value)
        let fraction = min(animatedValue / maxValue, 1.0)
        if fraction > 0.001 {
            let gradientEndAngle = 180.0 - fraction * 180.0
            let arcPath = Path { path in
                path.addArc(center: center, radius: (outerRadius + innerRadius) / 2,
                           startAngle: .degrees(180), endAngle: .degrees(gradientEndAngle),
                           clockwise: false)
            }

            // Multi-stop gradient shimmer
            let gradientColors: [Color] = [
                .green, .green, .yellow, .orange, .red
            ]
            let gradient = Gradient(colors: gradientColors)
            // Use a linear gradient across the arc as a color approximation
            context.stroke(arcPath,
                          with: .linearGradient(gradient,
                                               startPoint: CGPoint(x: center.x - outerRadius, y: center.y),
                                               endPoint: CGPoint(x: center.x + outerRadius, y: center.y)),
                          lineWidth: outerRadius - innerRadius)
        }

        // Major tick marks and labels
        let tickValues = [0.0, 1000, 2000, 3000, 4000, 5000]
        let tickLabels = ["0", "1k", "2k", "3k", "4k", "5k"]

        for (i, value) in tickValues.enumerated() {
            let tickFraction = value / maxValue
            let angle = Angle.degrees(180 - tickFraction * 180)

            // Tick mark
            let outerPoint = CGPoint(
                x: center.x + tickOuterRadius * CGFloat(cos(angle.radians)),
                y: center.y - tickOuterRadius * CGFloat(sin(angle.radians))
            )
            let innerPoint = CGPoint(
                x: center.x + (innerRadius - 5) * CGFloat(cos(angle.radians)),
                y: center.y - (innerRadius - 5) * CGFloat(sin(angle.radians))
            )

            let tickPath = Path { path in
                path.move(to: outerPoint)
                path.addLine(to: innerPoint)
            }
            context.stroke(tickPath, with: .color(Color(white: 0.5)), lineWidth: 2)

            // Label
            let labelRadius = innerRadius - 18
            let labelPoint = CGPoint(
                x: center.x + labelRadius * CGFloat(cos(angle.radians)),
                y: center.y - labelRadius * CGFloat(sin(angle.radians))
            )

            let text = Text(tickLabels[i])
                .font(.system(size: 10, weight: .medium, design: .monospaced))
                .foregroundColor(Color(white: 0.45))

            context.draw(context.resolve(text),
                        at: labelPoint, anchor: .center)
        }

        // Minor tick marks
        for value in stride(from: 0.0, through: 5000.0, by: 500.0) {
            if tickValues.contains(value) { continue }
            let tickFraction = value / maxValue
            let angle = Angle.degrees(180 - tickFraction * 180)

            let outerPoint = CGPoint(
                x: center.x + (tickOuterRadius - 3) * CGFloat(cos(angle.radians)),
                y: center.y - (tickOuterRadius - 3) * CGFloat(sin(angle.radians))
            )
            let innerPoint = CGPoint(
                x: center.x + (innerRadius + 2) * CGFloat(cos(angle.radians)),
                y: center.y - (innerRadius + 2) * CGFloat(sin(angle.radians))
            )

            let tickPath = Path { path in
                path.move(to: outerPoint)
                path.addLine(to: innerPoint)
            }
            context.stroke(tickPath, with: .color(Color(white: 0.3)), lineWidth: 1)
        }
    }
}


