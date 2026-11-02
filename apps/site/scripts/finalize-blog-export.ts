import { rm } from "node:fs/promises";
import { getPosts } from "../lib/blog";

// Next exports notFound() pages as HTML. Omit those files so static hosts serve
// a real 404 until the first article is published, including RSC navigation data.
if (!(await getPosts()).length) {
  await Promise.all(
    ["blog", "blog.html", "blog.txt"].map((name) =>
      rm(new URL(`../out/${name}`, import.meta.url), { recursive: true, force: true }),
    ),
  );
}
