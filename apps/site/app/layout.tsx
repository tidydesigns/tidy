import type { Metadata } from "next";
import localFont from "next/font/local";
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
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://tidydesign.co"),
  title: "Tidy — A product canvas",
  description:
    "A product canvas for designers, engineers, and agents. Work on interfaces together, connect agents through MCP, and self-host or extend the canvas.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${instrumentSans.className} ${instrumentSerif.variable}`}>
      <body>{children}</body>
    </html>
  );
}
