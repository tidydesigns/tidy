import type { MetadataRoute } from "next";
import { siteUrl } from "../lib/site-url";

export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["/", "/changelog", "/privacy"].map((route) => ({ url: new URL(route, siteUrl).href }));
}
