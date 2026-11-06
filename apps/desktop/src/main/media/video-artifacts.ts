import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, stat, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseChatLink } from "../../shared/models/chat-links";
import {
  videoMetadataSchema,
  type VideoArtifact,
  type VideoChunk,
  type VideoRead,
} from "../../shared/contracts/video-artifacts";
import { prepareVideo } from "./video-processing";

const MAX_VIDEO_BYTES = 1024 * 1024 * 1024;
const pending = new Set(["queued", "processing"]);
export type VideoBytes = Omit<VideoChunk, "base64"> & { bytes: Uint8Array };

/** Only explicit local video links in completed assistant prose become artifacts. */
export function videoLinks(text: string): VideoArtifact[] {
  const prose = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, "");
  const links = new Map<string, VideoArtifact>();
  for (const match of prose.matchAll(/(?<!!)\[[^\]\n]{1,200}\]\((?:<([^>\n]+)>|([^\s)]+))\)/g)) {
    const href = match[1] ?? match[2];
    const link = parseChatLink(href);
    if (link?.kind !== "file" || link.line || !/\.(mp4|m4v|mov|webm|mkv|avi)$/i.test(link.path))
      continue;
    if (!links.has(link.path))
      links.set(link.path, {
        id: randomUUID(),
        name: link.name.slice(0, 200),
        sourceHref: href,
        status: "queued",
      });
    if (links.size === 4) break;
  }
  return [...links.values()];
}

async function directory(root: string, id: string) {
  // root is private app data, outside the agent's execution checkout.
  const path = join(root, `video-${id}`);
  await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
    throw new Error("Video storage is unavailable.");
  return path;
}

async function copyOriginal(root: string, href: string, destination: string, signal: AbortSignal) {
  const link = parseChatLink(href);
  if (link?.kind !== "file") throw new Error("Choose a local video file.");
  const projectRoot = await realpath(root);
  const path = resolve(projectRoot, link.path);
  const actual = await realpath(path);
  const within = relative(projectRoot, actual);
  if (
    actual !== path ||
    !within ||
    isAbsolute(within) ||
    within === ".." ||
    within.startsWith(`..${sep}`)
  )
    throw new Error("Video files must stay inside this project's checkout without symlinks.");
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await source.stat();
    const current = await lstat(path);
    if (
      (await realpath(path)) !== path ||
      current.isSymbolicLink() ||
      current.dev !== before.dev ||
      current.ino !== before.ino
    )
      throw new Error("The video path changed while it was being registered.");
    if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > MAX_VIDEO_BYTES)
      throw new Error("Choose a regular video file under 1 GiB.");
    const target = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    try {
      const buffer = Buffer.alloc(256 * 1024);
      let position = 0;
      while (position < before.size) {
        signal.throwIfAborted();
        const { bytesRead } = await source.read(
          buffer,
          0,
          Math.min(buffer.length, before.size - position),
          position,
        );
        if (!bytesRead) throw new Error("The video changed while it was being registered.");
        let written = 0;
        while (written < bytesRead)
          written += (await target.write(buffer, written, bytesRead - written, position + written))
            .bytesWritten;
        position += bytesRead;
      }
      const after = await source.stat();
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new Error("The video changed while it was being registered.");
      return before.size;
    } finally {
      await target.close();
    }
  } finally {
    await source.close();
  }
}

type Work = {
  artifact: VideoArtifact;
  root: string;
  storage: () => Promise<string>;
  update: (patch: Partial<VideoArtifact>) => Promise<void>;
  controller: AbortController;
};

/** One background encoder per host. Queue entries contain no video bytes. */
export class VideoArtifacts {
  private jobs = new Map<string, Work>();
  private running?: Promise<void>;
  private closed = false;
  constructor(private prepare = prepareVideo) {}

  enqueue(input: Omit<Work, "controller">) {
    if (this.jobs.has(input.artifact.id)) return;
    if (this.closed || this.jobs.size >= 32)
      throw new Error(
        "Video processing is busy. Request the video again when processing finishes.",
      );
    this.jobs.set(input.artifact.id, { ...input, controller: new AbortController() });
    this.running ??= this.drain().finally(() => {
      this.running = undefined;
    });
  }

  cancel(id: string) {
    this.jobs.get(id)?.controller.abort();
  }
  async close() {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort();
    await this.running;
  }

  private async drain() {
    while (this.jobs.size) {
      const job = this.jobs.values().next().value!;
      const signal = job.controller.signal;
      let output: string | undefined;
      try {
        signal.throwIfAborted();
        await job.update({ status: "processing", error: undefined });
        output = await directory(await job.storage(), job.artifact.id);
        const original = join(output, "original");
        // A completed copy can survive a host restart; partial copies never become originals.
        let size: number;
        if (job.artifact.original) {
          const info = await lstat(original);
          if (
            !info.isFile() ||
            info.isSymbolicLink() ||
            info.nlink !== 1 ||
            info.size !== job.artifact.original.size
          )
            throw new Error("The original video is no longer available.");
          size = info.size;
        } else {
          const temporary = join(output, `copy-${randomUUID()}`);
          try {
            size = await copyOriginal(job.root, job.artifact.sourceHref, temporary, signal);
            await rename(temporary, original);
          } finally {
            await rm(temporary, { force: true });
          }
        }
        await job.update({ original: { size, mimeType: "application/octet-stream" } });
        const result = await this.prepare({
          sourcePath: original,
          outputDirectory: output,
          signal,
        });
        signal.throwIfAborted();
        // Normalize processor paths into fixed, non-user-controlled storage names.
        const playback = join(output, "playback");
        if (result.playbackFile !== original) await rename(result.playbackFile, playback);
        if (result.posterFile && result.posterFile !== join(output, "poster"))
          await rename(result.posterFile, join(output, "poster"));
        await job.update({
          status: "ready",
          error: undefined,
          width: result.width,
          height: result.height,
          duration: result.duration,
          codec: result.codec,
          transcoded: result.transcoded,
          original: { size, mimeType: result.originalMimeType },
          playbackUsesOriginal: result.playbackFile === original,
          playback: {
            size: (await stat(result.playbackFile === original ? original : playback)).size,
            mimeType: result.playbackMimeType,
          },
          poster: Boolean(result.posterFile),
        });
      } catch (error) {
        await job
          .update({
            status: signal.aborted ? (this.closed ? "queued" : "cancelled") : "failed",
            error: signal.aborted
              ? undefined
              : error instanceof Error
                ? error.message.slice(0, 500)
                : "Video preparation failed.",
          })
          .catch(() => {});
      } finally {
        // Retain only the original and successfully published playback/poster.
        if (output) {
          const { readdir } = await import("node:fs/promises");
          for (const name of await readdir(output).catch(() => []))
            if (!["original", "playback", "poster"].includes(name))
              await rm(join(output, name), { force: true }).catch(() => {});
        }
        this.jobs.delete(job.artifact.id);
      }
    }
  }
}

export async function readVideoArtifact(
  storage: string,
  artifact: VideoArtifact,
  input: VideoRead,
): Promise<VideoBytes> {
  const folder = await directory(storage, artifact.id);
  if (input.variant === "original" ? !artifact.original : artifact.status !== "ready")
    throw new Error("This video is not ready.");
  if (input.variant === "poster" && !artifact.poster)
    throw new Error("No video poster is available.");
  let path = join(folder, input.variant);
  if (input.variant === "playback") {
    if (artifact.playbackUsesOriginal) path = join(folder, "original");
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size <= 0 || info.size > MAX_VIDEO_BYTES * 2)
      throw new Error("This video is unavailable.");
    const buffer = Buffer.alloc(Math.min(input.length, Math.max(0, info.size - input.offset)));
    const { bytesRead } = buffer.length
      ? await file.read(buffer, 0, buffer.length, input.offset)
      : { bytesRead: 0 };
    const metadata = videoMetadataSchema.parse({
      size: info.size,
      mimeType:
        input.variant === "poster"
          ? "image/jpeg"
          : input.variant === "original"
            ? artifact.original!.mimeType
            : artifact.playback!.mimeType,
      name:
        input.variant === "original"
          ? basename(artifact.name)
          : input.variant === "poster"
            ? "poster.jpg"
            : `preview.${artifact.playback?.mimeType === "video/webm" ? "webm" : "mp4"}`,
    });
    return { ...metadata, bytes: buffer.subarray(0, bytesRead) };
  } finally {
    await file.close();
  }
}

export function videoPending(artifact: VideoArtifact) {
  return pending.has(artifact.status);
}
