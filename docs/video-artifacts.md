# Video artifacts in desktop threads

Agents return a generated video using a direct Markdown link to a file in the thread's execution checkout, for example `[Demo](./output/demo.mp4)`. Tidy registers up to four distinct local video links in each completed assistant message. It does not fetch remote URLs or interpret links inside code blocks as video requests. The same orchestration guidance is supplied to Codex, Claude and OpenCode.

The host copies the original into private application storage, then prepares playback in a background queue. Thread messages carry a small, validated artifact record; video bytes never enter conversation snapshots or prompts. Preparation does not block another turn. Queued and active previews can be cancelled independently of the agent. Interrupted preparation resumes when the thread is reopened after a host restart.

## Host requirements and formats

Install `ffmpeg` and `ffprobe` on the machine running the workspace host. Both must be available on PATH; macOS also checks the usual Homebrew installation paths. Tidy does not install executables or contact a generation provider automatically. Missing tools leave a clear preparation error and retain the copied original for download.

- Sources: MP4/M4V/MOV, WebM/MKV and AVI. File contents are probed; filename extensions alone do not establish a valid video.
- Compatible H.264, VP8 and VP9/yuv420p video is copied at source resolution up to 3840×2160 (2160×3840 for portrait) and 60 fps. H.264 is delivered as fast-start MP4; VP8/VP9 as WebM. A compatible fast-start MP4 with one video and at most one audio track is used directly, without a second playback file. Its atom boundaries are checked through EOF before pass-through, so finding an early playback header cannot hide a truncated media atom. This structural check does not decode or validate every frame.
- Video and audio compatibility are decided independently. Incompatible audio becomes AAC for MP4 or Opus for WebM without re-encoding compatible video. Compatible AAC or Opus/Vorbis audio is copied, even when the video needs conversion. Playback selects the first video and audio tracks; originals retain every track.
- Unsupported video codecs, pixel formats, or video above the playback size/frame-rate budget become H.264/yuv420p MP4. The software preset uses CRF 18, `fast`, at most 1920×1080 (1080×1920 for portrait) and 60 fps. Originals retain their source quality, audio and container.
- Posters preserve display rotation and non-square pixel proportions, use square pixels, and fit within 1280×1280 without enlarging the displayed source. Playback metadata describes the displayed dimensions, including rotation and pixel aspect ratio. The same geometry calculation bounds converted video.
- A JPEG poster loads near the viewport. Its URL resolves independently of playback and downloads, so a failed or slow poster cannot block playback. The player uses `preload="none"`, does not autoplay, and pauses when its thread or video leaves view.

Initial host limits are 1 GiB per source, one hour, 8192 pixels per side, 34 megapixels and 240 source fps. Pixel limits also apply to displayed geometry. One encoder runs per host, with at most 32 queued/active artifacts, two encoder threads, bounded subprocess output, a 30-second inspection deadline and a ten-minute encoding deadline. Oversized or incomplete previews fail without replacing the original.

## Delivery and authorization

Playback and original downloads support GET, HEAD and single byte ranges, including suffix ranges. The first read is capped at 256 KiB for startup and seeking; subsequent reads are capped at 1 MiB to reduce network round trips. There is no speculative read-ahead, and reads respect stream backpressure. In-process playback stays binary; encoding and decoding occur only when crossing the existing authenticated JSON RPC connection, including a local workspace served by a separate host process. Whole files are never buffered in IPC or browser memory.

Preserving compatible 4K removes preparation work and generation loss, but retains its source bitrate and decoding requirements. This version does not create adaptive bitrate variants or guarantee smooth 4K on slow connections. HDR tone mapping, hardware encoding and a binary remote media channel remain separate improvements; the original download preserves source fidelity when a fallback preview cannot.

Every read checks current project access and an artifact's membership in its thread. Native playback uses opaque, per-window capabilities revoked on navigation or window destruction. Browser development uses its existing authenticated session. Neither transport exposes arbitrary filesystem paths. Generated copies live in the host's private `video-artifacts` directory, outside the execution checkout and cloud design sync. They remain on that host; removing a project registration does not delete its media.

Source traversal, symbolic links, hard links and non-regular files are rejected. FFmpeg runs without a shell, with a restricted environment, bounded resources and an allowlist of local media demuxers/protocols. No database or cloud storage changes are required.

## Validation

The media tests exercise real probing/transcoding when FFmpeg is installed, master preservation, 4K pass-through, rotated/anamorphic geometry and posters, exact video/AAC packet preservation during partial conversion, invalid inputs, source isolation, queue cancellation, byte ranges, stream cancellation and capability revocation. Remote integration also verifies full-size chunks and trailing partial reads over the authenticated WebSocket connection. A workspace integration test verifies that preparation finishing during a subsequent agent turn preserves the newer conversation. Run the workspace checks from the repository root; real codec tests skip when the required executables are unavailable.

Native design animation export and AI video generation providers are separate capabilities. This pipeline accepts their finished files; it does not implement either renderer or provider.
