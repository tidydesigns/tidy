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

`icon.icns` contains the macOS icon sizes, including Retina resolutions.
`icon.ico` contains Windows sizes from 16 to 256 pixels. The PNG is also used for
Linux window icons and the development Dock icon on macOS.

After replacing the master PNG, regenerate both native formats on macOS from the
repository root:

```sh
bun apps/desktop/scripts/generate-icons.ts
```

Generation uses the macOS `sips` and `iconutil` utilities. Normal packaging uses
the committed icons and does not require these utilities on other platforms.
