// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "TokenBurn",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "TokenBurn",
            path: "Sources/TokenBurn"
        )
    ]
)
