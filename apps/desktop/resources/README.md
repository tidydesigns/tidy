# Desktop icon

`icon.png` is the 1024 × 1024 master rendered from the Tidy Co **Desktop icon — centered**
design (revision 3), created through Tidy MCP from the original **icon** design.
It preserves the white artboard, dark wordmark, font size and letter spacing.
The visible lettering is centered horizontally and vertically, with measured
139px left/right and 276px top/bottom margins at the 50% ink threshold.
The editable text layer is at x=64.8828125, y=85.90625 on the 500px artboard.
The render uses the
repository's `packages/ui/fonts/InstrumentSerif-Regular.woff2` because the MCP
preview could not embed that font.

`icon-macos.png` applies Apple's rounded-square mask and places the result in an
824px square centered on a transparent 1024px canvas. This is the legacy macOS
icon geometry: supplying the full-bleed square as an ICNS makes macOS add a grey
backplate around it. The wordmark remains centered within the white tile.
`icon.icns` contains this macOS artwork at every size, including Retina resolutions.
`icon.ico` contains Windows sizes from 16 to 256 pixels. Each PNG, including those
inside the native containers, is losslessly compressed with Oxipng. All icon sizes
and color profiles are retained; no quantization or resolution reduction is used.
All PNGs retain 32bpp RGBA: Windows requires it for ICO compatibility, and
macOS's legacy-icon shape detection adds a backplate to grayscale PNG entries
even when their decoded transparency is identical. Export
replacement masters as 8-bit RGBA PNGs; grayscale or RGB sources are rejected.

Packaged macOS and Windows apps use their embedded native icons, without a second
PNG in the application archive. Only Linux packages include the PNG for their
window icon. Development uses the platform PNG, including `icon-macos.png` for
the Dock on macOS. Neither PNG is shipped in the macOS application archive.

After replacing the master PNG, regenerate both native formats on macOS from the
repository root:

```sh
bun apps/desktop/scripts/generate-icons.ts
```

Generation requires Xcode 26+ with Icon Composer, Swift/AppKit, the macOS `sips`
and `iconutil` utilities, and
[Oxipng](https://github.com/oxipng/oxipng) (tested with 10.2.1; install with
`brew install oxipng`). Normal packaging uses the committed icons and does not
require these utilities. Icon Composer is used only to render Apple's mask; its
asset catalog and source document are not shipped. No image-processing dependency
is shipped in the app.

The root `Package.swift` exposes only the padding helper as a buildable executable
for CodeQL's Swift analysis. Run `swift build` from the repository root to check
it independently; icon generation continues to run the helper directly.
