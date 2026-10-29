import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { buildBlogImage } from "./build-blog-image.mjs";
import { getPosts } from "../lib/blog.ts";

test("blog covers have responsive formats, a social JPEG and stable content-derived URLs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "tidy-cover-"));
  try {
    const input = path.join(root, "input.png");
    await sharp({ create: { width: 200, height: 150, channels: 3, background: "#e19b84" } })
      .png()
      .toFile(input);
    const original = await readFile(input);
    const first = await buildBlogImage(input, "example", root);
    const second = await buildBlogImage(input, "example", root);
    assert.deepEqual(first, second);
    assert.deepEqual(await readFile(input), original);
    for (const format of ["avif", "webp"]) {
      assert.equal(first.sources[format].length, 5);
      for (const file of first.sources[format]) {
        const info = await sharp(path.join(root, "public", file.src)).metadata();
        assert.equal(info.width, file.width);
        assert.equal(info.height, (file.width * 9) / 16);
      }
    }
    assert.equal((await sharp(path.join(root, "public", first.share)).metadata()).format, "jpeg");
    const contentDirectory = path.join(root, "content/blog");
    await writeFile(
      path.join(contentDirectory, "example.md"),
      `---\ntitle: "Example"\ndescription: "A cover integration check"\ndate: "2026-10-29"\ncategory: "Design"\nartwork: "cloud-spectrum"\ncover: "example"\ncoverAlt: "A coral image"\n---\nArticle body.`,
    );
    assert.deepEqual((await getPosts(contentDirectory))[0].coverImage, first);
    // Sharp reports AVIF as HEIF with AV1 compression; it remains a supported input.
    await buildBlogImage(path.join(root, "public", first.sources.avif[0].src), "avif-input", root);
    await sharp({ create: { width: 200, height: 150, channels: 3, background: "#84bfe1" } })
      .png()
      .toFile(input);
    const changed = await buildBlogImage(input, "example", root);
    assert.notEqual(changed.share, first.share);
    await assert.rejects(buildBlogImage(input, "../escape", root), /kebab-case/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
