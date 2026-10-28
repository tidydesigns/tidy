# Product captures

These are browser captures of the running Tidy source, with public example data.
They are not generated artwork or HTML approximations of the interface.

- `canvas-*.png`: the shared `FileEditor` component used by the web app, mounted
  through `LocalCanvas` with an in-memory document. Layers and the real typography
  inspector are visible with the headline selected.
- `desktop-*.png`: the actual desktop `App`, showing the example agent thread,
  expanded native tool activity and floating live design preview. The transcript
  and tool results are fixture data; no agent or shell command runs in the demo.
  macOS traffic lights represent the native controls outside Electron's renderer.

Capture URLs on the site dev server:

- `/desktop-demo/index.html?view=canvas&theme=dark` (or `light`)
- `/desktop-demo/index.html?view=desktop&theme=dark` (or `light`)

For canvas captures, select **Hero / Headline** in the layer list. For desktop
captures, expand the tool activity group and its two entries. The desktop capture
seeds the app's persisted window position below the transcript and above the
composer, so the floating preview does not cover either.

The masters are 3840 × 2400, captured from the running app at a 1536 × 960 CSS
viewport. The T3 browser downsamples a whole-viewport snapshot to 1280 × 800. To
retain Retina detail, render the same-origin capture iframe with `transform-origin:
top left` and `scale(3)`, then capture nine tiles, translating it by one viewport
per column and row. Join the unmodified 1280 × 800 tiles into the master; do not
enlarge a small screenshot. Wait for fonts, image decoding and settled animation
before capturing; hide the parent Next.js development indicator. Set the iframe
element's `color-scheme` as well as the app theme to match the desired capture.

The website uses lossless WebP exports at 640, 960, 1280, 1920, 2400, 3200 and
3840 pixels, selected through `srcset` and `sizes`. Intrinsic dimensions reserve
the layout; below-the-fold images load lazily and decode asynchronously. No image
is upscaled, and no interface detail is fabricated. Original masters stay here;
only the selected responsive export is downloaded by the website. The small theme
adapter waits for the saved appearance setting before assigning a source, avoiding
an initial download in the wrong theme. A `noscript` picture supports system theme
selection without JavaScript.

From the repository root, regenerate exports with:

```sh
bun apps/site/scripts/build-product-captures.mjs
```

## Mobile hero

`desktop-initial-light.png` and `desktop-initial-dark.png` capture the interactive
hero's initial loaded state, with the default floating preview position and tool
activity collapsed. They use the actual desktop renderer and the same public
sample project as the live hero, without opening tools or rearranging the app.

These masters are 2560 × 1600: a 1280 × 800 CSS app window, captured as four
1280 × 800 tiles at 2× output resolution. With the T3 browser at 1536 × 960 CSS
pixels, scale the existing hero window by 2.4 and translate it one viewport for
each column and row. Include the hero's macOS window controls, but exclude its
border, shadow, surrounding page and development indicator. Wait for the
conversation, fonts and images to finish loading before capturing either theme.

The mobile hero uses these responsive exports at viewport widths up to 800px;
it does not fetch the interactive desktop demo on an initial mobile visit. Once
loaded on a wider screen, the demo stays mounted but hidden on mobile so edits
survive resizing. The static image fallback is also included in the server HTML
for visitors with JavaScript disabled.
