import path from "node:path";
import { execFileSync } from "node:child_process";
import { withPostHogConfig } from "@posthog/nextjs-config";
import type { NextConfig } from "next";

const release =
  process.env.NEXT_PUBLIC_APP_VERSION ||
  (() => {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: import.meta.dirname,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      // Source archives and newly initialized repositories have no commit yet.
      return "0.1.0-source";
    }
  })();
const uploadSourceMaps = process.env.POSTHOG_UPLOAD_SOURCEMAPS === "1";
if (uploadSourceMaps && (!process.env.POSTHOG_API_KEY || !process.env.POSTHOG_PROJECT_ID)) {
  throw new Error("POSTHOG_API_KEY and POSTHOG_PROJECT_ID are required to upload source maps");
}

const nextConfig: NextConfig = {
  env: { NEXT_PUBLIC_APP_VERSION: release },
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  transpilePackages: ["@bella/design", "@tidy/design-renderer", "@tidy/ui", "@tidy/gpt-plugin"],
  turbopack: { root: path.join(import.meta.dirname, "../..") },
  images: { unoptimized: true },
  async headers() {
    const authHeaders = [
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Cache-Control", value: "no-store" },
    ];
    return [
      {
        source: "/:path*",
        headers: [{ key: "Strict-Transport-Security", value: "max-age=31536000" }],
      },
      ...[
        "/api/auth/:path*",
        "/login",
        "/sign-up",
        "/verify-email",
        "/forgot-password",
        "/reset-password",
        "/mcp/consent",
      ].map((source) => ({ source, headers: authHeaders })),
    ];
  },
};

export default uploadSourceMaps
  ? withPostHogConfig(nextConfig, {
      personalApiKey: process.env.POSTHOG_API_KEY!,
      projectId: process.env.POSTHOG_PROJECT_ID!,
      host: process.env.POSTHOG_API_HOST ?? "https://eu.posthog.com",
      sourcemaps: {
        enabled: true,
        releaseName: "tidy-app",
        releaseVersion: release,
        deleteAfterUpload: true,
      },
    })
  : nextConfig;
