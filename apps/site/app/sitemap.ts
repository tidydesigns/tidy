import type { MetadataRoute } from "next";
import { siteUrl } from "../lib/site-url";
import { getPosts } from "../lib/blog";

export const dynamic = "force-static";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const posts = await getPosts();
  return [
    ...["/", "/about", "/blog", "/changelog", "/privacy"].map((route) => ({
      url: new URL(route, siteUrl).href,
    })),
    ...posts.map((post) => ({
      url: new URL(`/blog/${post.slug}`, siteUrl).href,
      lastModified: post.updated ?? post.date,
    })),
  ];
}
