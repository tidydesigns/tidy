# Desktop icons

macOS release artwork is exported directly from the approved local Tidy design,
**Tidy · Beta app icon explorations** (`f80d45f8-4f6d-4188-939e-5d0150114cab`):

| Release    | Design selection                                           | Master                 | Native icon      | Development Dock PNG  |
| ---------- | ---------------------------------------------------------- | ---------------------- | ---------------- | --------------------- |
| Beta       | 17, Violet glass, **production artwork without a badge**   | `macos/beta.png`       | `icon-beta.icns` | `icon-macos-beta.png` |
| Production | 13, Spectrum glass, **production artwork without a badge** | `macos/production.png` | `icon.icns`      | `icon-macos.png`      |

Beta builds display **Tidy (Beta)**. Stable versions display **Tidy**. The
version in `apps/desktop/package.json` selects both name and artwork; there is no
independent channel flag to drift out of sync. Both icons retain the full outlined
wordmark in its production position. Colour and application name distinguish beta.
Windows and Linux retain their existing white wordmark artwork (`icon.ico` and
`icon.png`).

## Export and regenerate

The two 1024 × 1024 masters are real exports of the selected design subtrees,
including their original cloud image fills, masks, radii and vector wordmark.
`macos/source.json` records the source design/node IDs, option numbers and hashes
of the selected scene, original image bytes and exported PNG. The export script
reads local assets; it never fetches images or depends on a preview screenshot.
Unsupported future styles fail instead of being silently omitted.

From the repository root, with the editable local design and its sibling assets:

```sh
bun apps/desktop/scripts/export-macos-icons.ts /path/to/.tidy/designs/f80d45f8-4f6d-4188-939e-5d0150114cab.json
bun apps/desktop/scripts/generate-macos-icons.ts
```

The export uses Sharp **only as a development tool**. It decodes the original
cloud fills without another lossy encode and rasterizes the outlined lettering
at 1024px. It preserves the actual source detail; the design's 1536 × 1024 cloud
fills supply the full square crop. PNG masters and native renditions are 8-bit
RGBA, with no palette quantization. Regeneration needs macOS Swift/AppKit, `sips`,
`iconutil` and [Oxipng](https://github.com/oxipng/oxipng) (`brew install oxipng`).
The approved exports already have their rounded mask, so Icon Composer is not
applied a second time. Normal builds use committed assets and need none of these
image-generation tools.

To regenerate the existing Windows ICO as well, run
`bun apps/desktop/scripts/generate-icons.ts`.

## Quality and runtime performance

Each macOS icon retains the existing native geometry: 824px artwork centred on a
transparent 1024px canvas, with a 100px inset on all sides. This avoids the extra
backplate macOS can add to full-bleed legacy icons. The ICNS includes 16, 32, 128,
256 and 512 point sizes at 1× and 2×, including the 1024px Retina rendition. Every
smaller size is derived directly from the master; images are never enlarged.
Embedded PNGs are losslessly optimized while keeping RGBA and colour profiles.
Tests verify the padding, rendition sizes, encoding and pixel-identical 1024px
ICNS/PNG artwork.

Packaging embeds **only the selected channel's ICNS** in the native application.
macOS reads that icon directly; packaged startup does not call `dock.setIcon`,
decode a duplicate PNG, rasterize SVG, fetch cloud textures or load Sharp. Masters,
provenance, development PNGs and the other channel's ICNS are excluded from the
app archive. Development uses the matching padded PNG once for the Dock.
The bundle ID, executable and application-data location remain unchanged.

The root `Package.swift` exposes the padding helper for Swift/CodeQL validation.
Run `swift build` from the repository root to check it independently.
