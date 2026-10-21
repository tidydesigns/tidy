# Desktop icon

`icon.png` is the 1024 × 1024 master rendered from the existing Tidy Co **icon**
design (revision 17), retrieved through Tidy MCP. It preserves the original white
artboard, dark wordmark, positioning and letter spacing. The render uses the
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
