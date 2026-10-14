import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  transpilePackages: ["@tidy/ui"],
  turbopack: { root: path.join(import.meta.dirname, "../..") },
};

export default nextConfig;
