# README media sources

`hero.html` is the 1600 × 1240 static composition for `../desktop-workspace.png`.
It shows the desktop thread workspace, agent controls and floating design preview.
Open it in a browser at that viewport and export a screenshot after fonts load.
`index.html` and `compositions/desktop.html` compose the 12-second silent video
at 1920 × 1080. Run `bun run check` and `bun run render` from this directory.
The render command writes `../desktop-loop.mp4`.

The recording uses the real desktop renderer at commit `cf3e394c` with an
in-memory sample project, adapted from the website demo in PR #191. Its
conversation is staged; no agent inference or code generation was recorded.
The interaction expands the canvas, opens its panels, selects the headline,
changes its size from 76 to 72, minimises the canvas and switches threads.
Only sample content appears in the recording.

Cloud textures reuse the atmosphere, coral and spectrum artwork from PR #191.
The full-bleed stippled cloud atmosphere uses the landing page's light-theme
opacity of 0.14 behind both compositions. The neutral surfaces use `#fafafa`, `#424242`, `#646464` and `#dedede`. Stepped silhouettes
follow the website. Instrument font files are bundled with their OFL licenses.
The sample design uses the system font. The video has no audio track.

Create the README preview from the MP4 with FFmpeg:

```sh
ffmpeg -i ../desktop-loop.mp4 -filter_complex "fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3" -loop 0 ../desktop-loop.gif
```
