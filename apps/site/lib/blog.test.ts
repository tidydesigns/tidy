import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getPosts, parsePost } from "./blog";

const source = (extra = "", body = "A useful article.\n\n## A section\n\nMore detail.") => `---
title: "Design and code"
description: "A practical guide to keeping design and implementation together."
date: "2026-10-29"
category: "Design"
artwork: "cloud-spectrum"
${extra}---
${body}`;
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("blog publication", () => {
  test("excludes drafts and orders publication dates without using filesystem modification times", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tidy-blog-"));
    directories.push(directory);
    await Promise.all([
      writeFile(path.join(directory, "draft.md"), source("draft: true\n")),
      writeFile(path.join(directory, "older.md"), source().replace("2026-10-29", "2026-10-28")),
      writeFile(path.join(directory, "latest.md"), source()),
      writeFile(path.join(directory, "notes.txt"), "Not an article"),
    ]);
    assert.deepEqual(
      (await getPosts(directory)).map((post) => post.slug),
      ["latest", "older"],
    );
  });

  test("rejects ambiguous publication data and invalid dates", () => {
    assert.throws(
      () => parsePost("example", source('draft: "false"\n')),
      /draft must be a boolean/,
    );
    assert.throws(
      () => parsePost("example", source().replace("2026-10-29", "2026-02-30")),
      /date must/,
    );
    assert.throws(() => parsePost("example", source('updated: "2026-10-28"\n')), /updated must/);
    assert.throws(
      () => parsePost("example", source().replace('"2026-10-29"', "2026-10-29")),
      /date must/,
    );
  });

  test("rejects executable front matter and invalid slugs", () => {
    assert.throws(
      () => parsePost("example", "---javascript\n({title: 'unsafe'})\n---\nText"),
      /YAML front matter/,
    );
    assert.throws(() => parsePost("../private", source()), /kebab-case/);
  });

  test("custom covers require a safe identifier and descriptive alt text", () => {
    assert.throws(
      () => parsePost("example", source('cover: "../private"\ncoverAlt: "Description"\n')),
      /cover must/,
    );
    assert.throws(() => parsePost("example", source('cover: "example"\n')), /coverAlt/);
    assert.equal(
      parsePost("example", source('cover: "example"\ncoverAlt: "Canvas and code"\n')).cover,
      "example",
    );
  });

  test("requires content and one page-level heading", () => {
    assert.throws(() => parsePost("example", source("", "")), /empty article/);
    assert.throws(() => parsePost("example", source("", "# Another title")), /headings at ##/);
    const post = parsePost("example", source('updated: "2026-10-30"\n'));
    assert.equal(post.updated, "2026-10-30");
    assert.ok(post.readingMinutes >= 1);
  });
});
