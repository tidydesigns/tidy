import { readFile } from "node:fs/promises";
import path from "node:path";

export type BlogCover = {
  width: number;
  height: number;
  sources: Record<"avif" | "webp", { src: string; width: number }[]>;
  share: string;
};

export async function readBlogCover(directory: string, name: string): Promise<BlogCover> {
  const cover: BlogCover = JSON.parse(
    await readFile(path.join(directory, "covers", `${name}.json`), "utf8"),
  );
  const safePath = (value: unknown) =>
    typeof value === "string" && /^\/blog\/[a-z0-9-]+\.(avif|webp|jpg)$/.test(value);
  if (
    !Number.isFinite(cover.width) ||
    cover.width <= 0 ||
    !Number.isFinite(cover.height) ||
    cover.height <= 0 ||
    !safePath(cover.share)
  )
    throw new Error(`Invalid blog cover: ${name}`);
  for (const format of ["avif", "webp"] as const) {
    if (
      !Array.isArray(cover.sources?.[format]) ||
      !cover.sources[format].length ||
      cover.sources[format].some(
        (file) => !safePath(file.src) || !Number.isFinite(file.width) || file.width <= 0,
      )
    )
      throw new Error(`Invalid ${format} sources for blog cover: ${name}`);
  }
  return cover;
}
