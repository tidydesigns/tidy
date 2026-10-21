// swift-tools-version: 5.9
import PackageDescription

// Give CodeQL's Swift autobuilder a target for the developer-only icon helper.
let package = Package(
    name: "TidyIconTools",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "pad-macos-icon",
            path: "apps/desktop/scripts/macos-icon"
        )
    ]
)
