import AppKit

// Legacy ICNS artwork occupies 824px of its 1024px canvas. The transparent
// margin keeps macOS from putting the full-bleed artwork inside a grey tile.
guard CommandLine.arguments.count == 3,
      let image = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
      ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fatalError("Expected a masked icon PNG and an output path.")
}
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.imageInterpolation = .high
image.draw(in: NSRect(x: 100, y: 100, width: 824, height: 824))
NSGraphicsContext.restoreGraphicsState()
guard let png = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Could not encode the macOS icon.")
}
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
