import type { MetadataRoute } from "next";
import { siteUrl } from "../lib/site-url";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: new URL("/", siteUrl).href }, { url: new URL("/changelog", siteUrl).href }];
}
