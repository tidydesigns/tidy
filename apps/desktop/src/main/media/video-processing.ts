import { spawn } from "node:child_process";
import { access, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

const safeInput = [
  "-protocol_whitelist",
  "file,pipe",
  "-format_whitelist",
  "mov,matroska,webm,avi",
];

async function executable(name: "ffmpeg" | "ffprobe") {
  // GUI launches on macOS often omit Homebrew from PATH.
  if (process.platform === "darwin")
    for (const directory of ["/opt/homebrew/bin", "/usr/local/bin"]) {
      const path = join(directory, name);
      if (
        await access(path, constants.X_OK).then(
          () => true,
          () => false,
        )
      )
        return path;
    }
  return name;
}

export async function runVideoTool(
  name: "ffmpeg" | "ffprobe",
  args: string[],
  signal: AbortSignal,
  timeout = 10 * 60_000,
) {
  signal.throwIfAborted();
  const command = await executable(name);
  signal.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const environment: NodeJS.ProcessEnv = {};
    for (const key of [
      "PATH",
      "HOME",
      "USERPROFILE",
      "SystemRoot",
      "TMPDIR",
      "TMP",
      "TEMP",
      "LANG",
    ])
      if (process.env[key]) environment[key] = process.env[key];
    const child = spawn(command, args, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    const output: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const abort = () => stop(new Error("Video preparation cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => stop(new Error("Video preparation took too long.")), timeout);
    child.stdout.on("data", (bytes: Buffer) => {
      size += bytes.length;
      if (size > 256 * 1024) stop(new Error("Video metadata exceeded the processing limit."));
      else output.push(bytes);
    });
    let diagnosticSize = 0;
    child.stderr.on("data", (bytes: Buffer) => {
      diagnosticSize += bytes.length;
      if (diagnosticSize > 256 * 1024)
        stop(new Error("Video processing produced too many errors."));
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      failure = new Error(
        error.code === "ENOENT"
          ? "Install ffmpeg and ffprobe on this host to prepare video previews. The original is still available."
          : "The host could not start video processing.",
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(
            "This video could not be processed. Check that the generated file is complete and playable.",
          ),
        );
      else resolve(Buffer.concat(output).toString("utf8"));
    });
  });
}

type Probe = {
  format?: { format_name?: string; duration?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    pix_fmt?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    sample_aspect_ratio?: string;
    side_data_list?: Array<{ rotation?: number }>;
    disposition?: { attached_pic?: number };
  }>;
};
export function videoPolicy(probe: Probe) {
  const video = probe.streams?.find(
    (stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic,
  );
  // Match the first audio stream selected by -map 0:a:0?, not unused tracks.
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  const duration = Number(probe.format?.duration);
  const width = video?.width ?? 0;
  const height = video?.height ?? 0;
  const [numerator, denominator = 1] = (video?.avg_frame_rate ?? "0").split("/").map(Number);
  const fps = numerator / denominator;
  if (
    !video ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 8192 ||
    height > 8192 ||
    width * height > 34_000_000 ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 3600 ||
    !Number.isFinite(fps) ||
    fps <= 0 ||
    fps > 240
  )
    throw new Error(
      "Use a complete video up to one hour, 8192 pixels per side, 34 megapixels and 240 fps.",
    );
  const format = probe.format?.format_name ?? "";
  const mp4 = format.split(",").includes("mov");
  const webm = format.split(",").includes("webm");
  if (!mp4 && !webm && format !== "avi") throw new Error("This video container is not supported.");
  const [sarWidth, sarHeight] = (video.sample_aspect_ratio ?? "1:1").split(":").map(Number);
  // Missing/unspecified SAR is square; explicit extreme geometry must not allocate huge frames.
  const sar = sarWidth > 0 && sarHeight > 0 ? sarWidth / sarHeight : 1;
  const rotation = video.side_data_list?.find((item) => item.rotation !== undefined)?.rotation ?? 0;
  let displayWidth = Math.round(width * sar);
  let displayHeight = height;
  if (Math.abs(rotation % 180) === 90)
    [displayWidth, displayHeight] = [displayHeight, displayWidth];
  if (
    !Number.isFinite(sar) ||
    !Number.isFinite(rotation) ||
    displayWidth < 1 ||
    displayHeight < 1 ||
    displayWidth > 8192 ||
    displayHeight > 8192 ||
    displayWidth * displayHeight > 34_000_000
  )
    throw new Error("The video's display dimensions exceed the playback limits.");
  const copyVideo =
    width <= 3840 &&
    height <= 3840 &&
    Math.min(width, height) <= 2160 &&
    fps <= 60 &&
    Math.max(displayWidth, displayHeight) <= 3840 &&
    Math.min(displayWidth, displayHeight) <= 2160 &&
    video.pix_fmt === "yuv420p" &&
    ["h264", "vp8", "vp9"].includes(video.codec_name ?? "");
  const container = copyVideo && video.codec_name !== "h264" ? "webm" : "mp4";
  const copyAudio =
    !audio ||
    (container === "mp4"
      ? audio.codec_name === "aac"
      : ["opus", "vorbis"].includes(audio.codec_name ?? ""));
  return {
    width: displayWidth,
    height: displayHeight,
    duration,
    fps,
    codec: video.codec_name ?? "unknown",
    container,
    copyVideo,
    copyAudio,
    canUseOriginal:
      mp4 &&
      container === "mp4" &&
      copyVideo &&
      copyAudio &&
      probe.streams?.filter((stream) => stream.codec_type === "video").length === 1 &&
      (probe.streams?.filter((stream) => stream.codec_type === "audio").length ?? 0) <= 1,
    originalMimeType: mp4 ? "video/mp4" : webm ? "video/x-matroska" : "video/x-msvideo",
  };
}

async function probeVideo(path: string, signal: AbortSignal) {
  return videoPolicy(
    JSON.parse(
      await runVideoTool(
        "ffprobe",
        [
          "-v",
          "error",
          "-max_alloc",
          "134217728",
          ...safeInput,
          "-show_entries",
          "format=format_name,duration:stream=codec_type,codec_name,pix_fmt,width,height,avg_frame_rate,sample_aspect_ratio:stream_disposition=attached_pic:stream_side_data=rotation",
          "-of",
          "json",
          path,
        ],
        signal,
        30_000,
      ),
    ) as Probe,
  );
}

/** Fit displayed geometry once, without upscaling or relying on version-specific scale options. */
function fitVideo(width: number, height: number, longSide: number, shortSide: number) {
  const scale = Math.min(
    1,
    longSide / Math.max(width, height),
    shortSide / Math.min(width, height),
  );
  const w = Math.max(2, Math.floor((width * scale) / 2) * 2);
  const h = Math.max(2, Math.floor((height * scale) / 2) * 2);
  return `scale=${w}:${h},setsar=1`;
}

/** Read MP4 atom headers only, without buffering media payloads. */
async function fastStart(path: string) {
  const file = await open(path, "r");
  try {
    const size = (await file.stat()).size;
    const header = Buffer.alloc(16);
    let offset = 0;
    let movie = false;
    let media = false;
    for (let count = 0; count < 1024 && offset + 8 <= size; count++) {
      const { bytesRead } = await file.read(header, 0, 16, offset);
      if (bytesRead < 8) return false;
      const type = header.toString("ascii", 4, 8);
      let length = header.readUInt32BE(0);
      const extended = length === 1;
      if (extended) {
        if (bytesRead < 16) return false;
        length = Number(header.readBigUInt64BE(8));
      } else if (length === 0) length = size - offset;
      if (!Number.isSafeInteger(length) || length < (extended ? 16 : 8)) return false;
      if (offset + length > size)
        throw new Error("The video is incomplete. The original is still available.");
      if (type === "moov") movie = true;
      if (type === "mdat") {
        if (!movie) return false;
        media = true;
      }
      offset += length;
    }
    return offset === size && movie && media;
  } finally {
    await file.close();
  }
}

export async function prepareVideo({
  sourcePath,
  outputDirectory,
  signal,
}: {
  sourcePath: string;
  outputDirectory: string;
  signal: AbortSignal;
}) {
  const original = await probeVideo(sourcePath, signal);
  const webm = original.container === "webm";
  const passthrough = original.canUseOriginal && (await fastStart(sourcePath));
  const playbackFile = passthrough
    ? sourcePath
    : join(outputDirectory, webm ? "prepared.webm" : "prepared.mp4");
  if (!passthrough) {
    const args = [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-max_alloc",
      "134217728",
      "-threads",
      "2",
      ...safeInput,
      "-i",
      sourcePath,
      "-map",
      "0:V:0",
      "-map",
      "0:a:0?",
      "-map_metadata",
      "-1",
      "-map_chapters",
      "-1",
    ];
    if (!original.copyVideo)
      args.push(
        "-vf",
        fitVideo(original.width, original.height, 1920, 1080),
        "-filter_threads",
        "2",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-threads",
        "2",
        ...(original.fps > 60 ? ["-r", "60"] : []),
      );
    else args.push("-c:v", "copy");
    args.push("-c:a", original.copyAudio ? "copy" : webm ? "libopus" : "aac");
    if (!original.copyAudio) args.push("-b:a", "160k");
    if (!webm) args.push("-movflags", "+faststart");
    args.push("-fs", String(1024 * 1024 * 1024), playbackFile);
    await runVideoTool("ffmpeg", args, signal);
  }
  const playback = passthrough ? original : await probeVideo(playbackFile, signal);
  if (Math.abs(playback.duration - original.duration) > Math.max(0.25, 2 / original.fps))
    throw new Error("The preview was incomplete. The original is still available.");
  let posterFile: string | undefined = join(outputDirectory, "prepared.jpg");
  try {
    await runVideoTool(
      "ffmpeg",
      [
        "-v",
        "error",
        "-nostdin",
        "-y",
        "-threads",
        "2",
        ...safeInput,
        "-i",
        playbackFile,
        "-map",
        "0:V:0",
        "-frames:v",
        "1",
        "-vf",
        fitVideo(playback.width, playback.height, 1280, 1280),
        "-filter_threads",
        "2",
        "-q:v",
        "3",
        posterFile,
      ],
      signal,
      30_000,
    );
  } catch {
    signal.throwIfAborted();
    posterFile = undefined;
  }
  return {
    width: playback.width,
    height: playback.height,
    duration: playback.duration,
    codec: playback.codec,
    originalMimeType: original.originalMimeType,
    playbackFile,
    playbackMimeType: webm ? ("video/webm" as const) : ("video/mp4" as const),
    posterFile,
    transcoded: !original.copyVideo || !original.copyAudio,
  };
}
