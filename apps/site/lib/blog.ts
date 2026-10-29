import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { cache } from "react";
import matter from "gray-matter";
import { readBlogCover, type BlogCover } from "./blog-cover";

export type BlogPost = {
  slug: string;
  title: string;
  seoTitle?: string;
  description: string;
  date: string;
  updated?: string;
  category: string;
  artwork: "cloud-coral" | "cloud-spectrum";
  cover?: string;
  coverAlt?: string;
  coverImage?: BlogCover;
  draft: boolean;
  body: string;
  readingMinutes: number;
};

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parsePost(slug: string, source: string): BlogPost {
  const fail = (message: string): never => {
    throw new Error(`Blog post ${slug}: ${message}`);
  };
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) fail("use a kebab-case filename");
  // Only YAML front matter is accepted; never enable executable front-matter engines.
  if (!/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.test(source)) fail("missing YAML front matter");
  const { data, content } = matter(source);
  const string = (key: string) => {
    const value: unknown = data[key];
    if (typeof value !== "string" || !value.trim()) return fail(`missing ${key}`);
    return value.trim();
  };
  if (!isDate(data.date)) fail("date must be a quoted YYYY-MM-DD date");
  if (data.updated !== undefined && (!isDate(data.updated) || data.updated < data.date)) {
    fail("updated must be a quoted date on or after date");
  }
  if (data.draft !== undefined && typeof data.draft !== "boolean") fail("draft must be a boolean");
  if (data.artwork !== "cloud-coral" && data.artwork !== "cloud-spectrum") fail("unknown artwork");
  if (
    data.cover !== undefined &&
    (typeof data.cover !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.cover))
  )
    fail("cover must be a kebab-case image name");
  if (!content.trim()) fail("empty article");
  if (/^#\s/m.test(content)) fail("start article headings at ##; the page provides the title");
  return {
    slug,
    title: string("title"),
    seoTitle: data.seoTitle === undefined ? undefined : string("seoTitle"),
    description: string("description"),
    date: data.date,
    updated: data.updated,
    category: string("category"),
    artwork: data.artwork,
    cover: data.cover,
    coverAlt: data.cover === undefined ? undefined : string("coverAlt"),
    draft: data.draft === true,
    body: content.trim(),
    readingMinutes: Math.max(1, Math.ceil(content.trim().split(/\s+/).length / 220)),
  };
}

// Runs during static generation, never in the browser or against a database.
export const getPosts = cache(async (directory = path.join(process.cwd(), "content/blog")) => {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".md"));
  const posts = await Promise.all(
    files.map(async (file) => {
      const post = parsePost(file.slice(0, -3), await readFile(path.join(directory, file), "utf8"));
      if (post.cover && !post.draft) post.coverImage = await readBlogCover(directory, post.cover);
      return post;
    }),
  );
  return posts
    .filter((post) => !post.draft)
    .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
});

export async function getPost(slug: string) {
  return (await getPosts()).find((post) => post.slug === slug);
}

export function formatPostDate(date: string) {
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}
