import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: process.env.NODE_ENV === "development" ? undefined : "export",
  transpilePackages: ["@tidy/ui"],
  turbopack: { root: path.join(import.meta.dirname, "../..") },
  ...(process.env.NODE_ENV === "development" && process.env.TIDY_SITE_DOWNLOAD_ORIGIN
    ? {
        async rewrites() {
          return [
            {
              source: "/download/mac",
              destination: `${process.env.TIDY_SITE_DOWNLOAD_ORIGIN}/download/mac`,
            },
          ];
        },
      }
    : {}),
};

export default nextConfig;
