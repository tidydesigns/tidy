import type { Metadata } from "next";
import localFont from "next/font/local";
import { siteUrl } from "../lib/site-url";
import { pageMetadata } from "../lib/page-metadata";
import "./globals.css";

const instrumentSans = localFont({
  src: "./fonts/instrument-sans-latin.woff2",
  weight: "400 700",
  display: "swap",
});

const instrumentSerif = localFont({
  src: "./fonts/InstrumentSerif-Regular.woff2",
  variable: "--font-instrument-serif",
  weight: "400",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: siteUrl,
  ...pageMetadata(
    "/",
    "Tidy. Open-source design canvas for teams and AI agents",
    "Design interfaces together in Tidy. Edit designs with AI agents through MCP, capture webpages, and self-host an open-source product canvas under Apache 2.0.",
  ),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${instrumentSans.className} ${instrumentSerif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
