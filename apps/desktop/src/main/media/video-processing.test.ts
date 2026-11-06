import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareVideo, runVideoTool, videoPolicy } from "./video-processing";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
const probe = (codec = "h264", width = 1920, height = 1080, fps = "60/1") => ({
  format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "2" },
  streams: [
    {
      codec_type: "video",
      codec_name: codec,
      pix_fmt: "yuv420p",
      width,
      height,
      avg_frame_rate: fps,
    },
    { codec_type: "audio", codec_name: "aac" },
  ],
});
test("playback policy preserves compatible 4K streams and converts streams independently", () => {
  expect(videoPolicy(probe())).toMatchObject({
    container: "mp4",
    copyVideo: true,
    copyAudio: true,
  });
  expect(videoPolicy(probe("hevc"))).toMatchObject({ copyVideo: false, copyAudio: true });
  expect(videoPolicy(probe("h264", 3840, 2160)).copyVideo).toBe(true);
  expect(videoPolicy(probe("h264", 2160, 3840)).copyVideo).toBe(true);
  expect(videoPolicy(probe("h264", 7680, 4320)).copyVideo).toBe(false);
  expect(videoPolicy(probe("h264", 1920, 1080, "120/1")).copyVideo).toBe(false);
  const mixed = probe();
  mixed.streams[1].codec_name = "pcm_s16le";
  expect(videoPolicy(mixed)).toMatchObject({
    copyVideo: true,
    copyAudio: false,
    canUseOriginal: false,
  });
  const additionalTrack = probe();
  additionalTrack.streams.push({ codec_type: "audio", codec_name: "ac3" });
  expect(videoPolicy(additionalTrack)).toMatchObject({
    copyVideo: true,
    copyAudio: true,
    canUseOriginal: false,
  });
  expect(
    videoPolicy({
      format: { format_name: "matroska,webm", duration: "3" },
      streams: [
        {
          codec_type: "video",
          codec_name: "vp9",
          pix_fmt: "yuv420p",
          width: 640,
          height: 360,
          avg_frame_rate: "30/1",
        },
      ],
    }).container,
  ).toBe("webm");
  expect(() => videoPolicy({ format: { duration: "NaN" }, streams: [] })).toThrow();
  expect(() => videoPolicy(probe("h264", 9000, 2000))).toThrow();
  expect(() => videoPolicy(probe("h264", 1920, 1080, "0/0"))).toThrow();
  expect(() =>
    videoPolicy({ ...probe(), format: { format_name: "hls", duration: "2" } }),
  ).toThrow();
});
test("cancelled processing never launches an encoder", async () => {
  const abort = new AbortController();
  abort.abort();
  await expect(runVideoTool("ffmpeg", ["-version"], abort.signal)).rejects.toThrow();
});
test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "real files retain master bytes, pass through fast-start MP4, and transcode unsupported playback",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "tidy-video-processing-"));
    directories.push(root);
    const signal = new AbortController().signal;
    const original = join(root, "master.mp4");
    await runVideoTool(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=30",
        "-t",
        "0.5",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        original,
      ],
      signal,
    );
    const bytes = await readFile(original);
    const result = await prepareVideo({ sourcePath: original, outputDirectory: root, signal });
    expect(result.playbackFile).toBe(original);
    expect(result.transcoded).toBe(false);
    expect(result.width).toBe(320);
    expect(result.posterFile).toBeDefined();
    expect(await readFile(original)).toEqual(bytes);
    const truncated = join(root, "truncated.mp4");
    await writeFile(truncated, bytes.subarray(0, Math.floor(bytes.length * 0.6)));
    await expect(
      prepareVideo({ sourcePath: truncated, outputDirectory: root, signal }),
    ).rejects.toThrow();
    const fragmented = join(root, "fragmented.mp4");
    await runVideoTool(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        original,
        "-c",
        "copy",
        "-movflags",
        "+frag_keyframe+empty_moov",
        fragmented,
      ],
      signal,
    );
    expect(
      (await prepareVideo({ sourcePath: fragmented, outputDirectory: root, signal })).playbackFile,
    ).toBe(fragmented);
    // A zero-sized final mdat legally extends to EOF.
    const toEOF = Buffer.from(bytes);
    const mediaHeader = toEOF.indexOf(Buffer.from("mdat"));
    expect(mediaHeader).toBeGreaterThan(4);
    toEOF.writeUInt32BE(0, mediaHeader - 4);
    const unboundedAtom = join(root, "to-eof.mp4");
    await writeFile(unboundedAtom, toEOF);
    expect(
      (await prepareVideo({ sourcePath: unboundedAtom, outputDirectory: root, signal }))
        .playbackFile,
    ).toBe(unboundedAtom);
    const avi = join(root, "master.avi");
    await runVideoTool("ffmpeg", ["-v", "error", "-i", original, "-c:v", "mpeg4", avi], signal);
    const encoded = await prepareVideo({ sourcePath: avi, outputDirectory: root, signal });
    expect(encoded.transcoded).toBe(true);
    expect(encoded.codec).toBe("h264");
    expect(encoded.playbackMimeType).toBe("video/mp4");
    expect(encoded.duration).toBeCloseTo(result.duration, 1);
    await writeFile(join(root, "fake.mp4"), "#EXTM3U\nhttps://example.com/private.mp4");
    await expect(
      prepareVideo({ sourcePath: join(root, "fake.mp4"), outputDirectory: root, signal }),
    ).rejects.toThrow();
  },
  30_000,
);

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "anamorphic and rotated video retain display geometry in playback and square-pixel posters",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "tidy-video-geometry-"));
    directories.push(root);
    const signal = new AbortController().signal;
    const source = join(root, "anamorphic.mp4");
    await runVideoTool(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=720x576:rate=24",
        "-vf",
        "setsar=64/45",
        "-t",
        "0.25",
        "-c:v",
        "libx264",
        "-threads",
        "2",
        "-movflags",
        "+faststart",
        source,
      ],
      signal,
    );
    const inspect = async (path: string) =>
      JSON.parse(
        await runVideoTool(
          "ffprobe",
          [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,sample_aspect_ratio",
            "-of",
            "json",
            path,
          ],
          signal,
        ),
      ).streams[0];
    const normal = await prepareVideo({ sourcePath: source, outputDirectory: root, signal });
    expect([normal.width, normal.height]).toEqual([1024, 576]);
    expect(normal.playbackFile).toBe(source);
    expect(await inspect(normal.posterFile!)).toMatchObject({
      width: 1024,
      height: 576,
      sample_aspect_ratio: "1:1",
    });
    // Rotation is carried as a display matrix, not a physical change to stored pixels.
    const rotated = join(root, "rotated.mp4");
    await runVideoTool(
      "ffmpeg",
      [
        "-v",
        "error",
        "-display_rotation",
        "90",
        "-i",
        source,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        rotated,
      ],
      signal,
    );
    const portrait = await prepareVideo({ sourcePath: rotated, outputDirectory: root, signal });
    expect([portrait.width, portrait.height]).toEqual([576, 1024]);
    expect(portrait.playbackFile).toBe(rotated);
    expect(await inspect(portrait.posterFile!)).toMatchObject({
      width: 576,
      height: 1024,
      sample_aspect_ratio: "1:1",
    });
    const incompatible = join(root, "anamorphic.mkv");
    await runVideoTool(
      "ffmpeg",
      ["-v", "error", "-i", source, "-c:v", "ffv1", incompatible],
      signal,
    );
    const converted = await prepareVideo({
      sourcePath: incompatible,
      outputDirectory: root,
      signal,
    });
    expect([converted.width, converted.height]).toEqual([1024, 576]);
    expect(await inspect(converted.playbackFile)).toMatchObject({
      width: 1024,
      height: 576,
      sample_aspect_ratio: "1:1",
    });
  },
  30_000,
);

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "audio repair retains exact video packets and video conversion retains exact AAC packets",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "tidy-video-stream-copy-"));
    directories.push(root);
    const signal = new AbortController().signal;
    const hashes = async (path: string, stream: string) =>
      JSON.parse(
        await runVideoTool(
          "ffprobe",
          [
            "-v",
            "error",
            "-select_streams",
            stream,
            "-show_packets",
            "-show_entries",
            "packet=data_hash",
            "-show_data_hash",
            "sha256",
            "-of",
            "json",
            path,
          ],
          signal,
        ),
      ).packets;
    const mixed = join(root, "mixed.mov");
    await runVideoTool(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=30",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440",
        "-t",
        "0.5",
        "-c:v",
        "libx264",
        "-c:a",
        "pcm_s16le",
        mixed,
      ],
      signal,
    );
    const repaired = await prepareVideo({ sourcePath: mixed, outputDirectory: root, signal });
    expect(repaired.playbackFile).not.toBe(mixed);
    const sourceVideo = await hashes(mixed, "v:0");
    expect(sourceVideo.length).toBeGreaterThan(0);
    expect(await hashes(repaired.playbackFile, "v:0")).toEqual(sourceVideo);
    const incompatible = join(root, "incompatible.mp4");
    await runVideoTool(
      "ffmpeg",
      ["-v", "error", "-i", mixed, "-c:v", "mpeg4", "-c:a", "aac", incompatible],
      signal,
    );
    const sourceAudio = await hashes(incompatible, "a:0");
    const converted = await prepareVideo({
      sourcePath: incompatible,
      outputDirectory: root,
      signal,
    });
    expect(converted.codec).toBe("h264");
    expect(sourceAudio.length).toBeGreaterThan(0);
    expect(await hashes(converted.playbackFile, "a:0")).toEqual(sourceAudio);
  },
  30_000,
);

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))(
  "compatible fast-start 4K stays at source resolution without another playback file",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "tidy-video-4k-"));
    directories.push(root);
    const signal = new AbortController().signal;
    const source = join(root, "master.mp4");
    await runVideoTool(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=3840x2160:rate=24",
        "-t",
        "0.125",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-threads",
        "2",
        "-movflags",
        "+faststart",
        source,
      ],
      signal,
    );
    const result = await prepareVideo({ sourcePath: source, outputDirectory: root, signal });
    expect(result.playbackFile).toBe(source);
    expect(result.transcoded).toBe(false);
    expect([result.width, result.height]).toEqual([3840, 2160]);
  },
  30_000,
);
