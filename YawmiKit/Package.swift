// swift-tools-version: 6.2
import PackageDescription

// `Domain` and `SyncClient` import Foundation only (no Apple frameworks), so the package builds
// and tests on Windows. Default isolation is `nonisolated` (SE-0466 with no default actor):
// these are pure value types and functions that must be callable from any context.
let package = Package(
    name: "YawmiKit",
    products: [
        .library(name: "Domain", targets: ["Domain"]),
        .library(name: "SyncClient", targets: ["SyncClient"]),
    ],
    targets: [
        .target(
            name: "Domain",
            swiftSettings: [.defaultIsolation(nil)]
        ),
        .target(
            name: "SyncClient",
            dependencies: ["Domain"],
            swiftSettings: [.defaultIsolation(nil)]
        ),
        .testTarget(
            name: "DomainTests",
            dependencies: ["Domain"],
            swiftSettings: [.defaultIsolation(nil)]
        ),
    ]
)
