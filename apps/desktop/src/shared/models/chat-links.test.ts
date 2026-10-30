import { expect, test } from "bun:test";
import { fileIconName, parseChatLink } from "./chat-links";

const videos = ["mp4", "m4v", "mov", "webm", "mkv", "avi", "mpg", "mpeg", "ogv", "3gp", "3g2"];
const audio = ["mp3", "wav", "flac", "aac", "m4a", "ogg", "oga", "opus", "aif", "aiff"];
const images = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "svg",
  "ico",
  "bmp",
  "tif",
  "tiff",
  "heic",
  "heif",
];

for (const [icon, extensions] of [
  ["video", videos],
  ["audio", audio],
  ["image", images],
] as const) {
  test(`${icon} references recognize uppercase extensions and decoded local paths`, () => {
    for (const extension of extensions)
      expect(fileIconName(`recordings/Review.${extension.toUpperCase()}`)).toBe(icon);
    const link = parseChatLink(`recordings/Design%20review.${extensions[0]}`);
    expect(link).toMatchObject({ kind: "file", name: `Design review.${extensions[0]}` });
    if (link?.kind !== "file") throw new Error("Expected a file reference.");
    expect(fileIconName(link.path)).toBe(icon);
    expect(fileIconName(`C:\\recordings\\review.${extensions[0]}`)).toBe(icon);
  });
}

test("code extensions remain distinct from media and filenames do not imply file type", () => {
  for (const [path, icon] of [
    ["src/types.ts", "typescript"],
    ["src/config.mts", "typescript"],
    ["src/config.cts", "typescript"],
    ["src/Button.tsx", "react"],
    ["C:\\src\\Button.JSX", "react"],
    ["src/index.js", "javascript"],
    ["src/index.mjs", "javascript"],
    ["src/index.cjs", "javascript"],
    ["styles.css", "css"],
    ["README.md", "markdown"],
    ["review.mp4.txt", "file"],
    ["movie.ts", "typescript"],
    ["notes.mp4.json", "json"],
    ["unknown.xyz", "file"],
  ] as const)
    expect(fileIconName(path)).toBe(icon);
});

test("line and column references work with encoded punctuation, unicode, and file URLs", () => {
  expect(parseChatLink("file:///project/Design%20review.MP4")).toMatchObject({
    kind: "file",
    name: "Design review.MP4",
  });
  expect(parseChatLink("src/组件.tsx#L24C5-L30")).toMatchObject({
    kind: "file",
    name: "组件.tsx",
    line: 24,
    column: 5,
  });
  expect(parseChatLink("src/a%23b%3Ftest.ts:12:3")).toMatchObject({
    kind: "file",
    path: "src/a#b?test.ts",
    line: 12,
    column: 3,
  });
  expect(parseChatLink("src/a.ts:9007199254740992")).toBeNull();
  expect(parseChatLink("src/a.ts:12:9007199254740992")).toBeNull();
});

test("service icons require the actual destination and a standard port", () => {
  expect(parseChatLink("https://GITHUB.com:443/owner/repo")).toMatchObject({ service: "github" });
  for (const href of [
    "https://github.com:444/owner/repo",
    "https://github.com.example.com/repo",
    "https://example.com/github.com",
    "https://github.com./owner/repo",
  ]) {
    expect(parseChatLink(href)).toMatchObject({ kind: "external", service: null });
  }
  expect(parseChatLink("mailto:design@example.com?subject=Review")).toMatchObject({
    kind: "external",
    service: null,
  });
});
