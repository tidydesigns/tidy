# Tidy cloud artwork

Production artwork for the neutral Tidy website and its rainbow cloud blocks.

The PNGs in `masters/` are newly generated original files, created with the built-in image-generation tool using the earlier Tidy cloud artwork as visual references. Prompts are preserved in `prompts.json`. Keep these masters separate from encoded web assets.

| Master                 | Native resolution | Use                                                                               |
| ---------------------- | ----------------- | --------------------------------------------------------------------------------- |
| `cloud-atmosphere.png` | 1254 × 1254       | Square monochrome scene, so a tall footer does not magnify a short landscape crop |
| `cloud-spectrum.png`   | 1536 × 1024       | Orange, yellow, emerald and cyan cloud blocks                                     |
| `cloud-coral.png`      | 1536 × 1024       | Coral, pink and violet cloud blocks                                               |

These are the generator’s actual native dimensions, not claimed 4K or enlarged exports. The hero and footer each render one full-width atmosphere with centered cover cropping, matching the exploration. They share `CloudAtmosphere` so their image treatment stays consistent. The source retains its native resolution; filling a wider viewport does not add source detail. The colour blocks are bounded to 280 CSS pixels and have sufficient source detail at 2× density. All hard stepped edges and the Instrument Serif wordmark are vectors and remain sharp at any density.

Run from the repository root:

```sh
node apps/site/scripts/build-cloud-artwork.mjs
```

This writes AVIF and WebP sources at 480, 768, 1024 and the master’s native width into `apps/site/public/artwork/`. No image is enlarged. A native-size quality-98 WebP for Tidy is written to `design/`. The manifest records source dimensions, byte sizes and master hashes. Neutral exports are normalized to grayscale; the rainbow palettes are preserved.

`CloudArtwork` serves responsive `<picture>` sources without needing a runtime image service, compatible with this Next.js static export. Images have intrinsic dimensions, empty decorative alt text, asynchronous decode and lazy loading. Only the chosen format/size is requested.

`CloudArtwork` is used throughout the Machine homepage. The atmosphere has no edge masks, gradient overlays or solid panels behind the hero/footer invitation; footer navigation retains its solid accessible surface. Its hero artwork loads eagerly; below-the-fold artwork remains lazy. `CloudFooter` is rendered on the server, with a small `AnimatedWordmark` client component for motion. It renders real links, the new artwork and the Instrument Serif vector wordmark. Its letter reveal uses only transforms and opacity, runs once when visible, pauses in hidden tabs, and respects reduced motion. The complete wordmark remains visible without JavaScript. Both themes use the app’s neutral values; colour is confined to the cloud artwork.

To replace a master with a higher native-resolution source later, retain its filename and rerun the pipeline. Do not enlarge a small image or adjust dimensions in the manifest to imply additional detail.
