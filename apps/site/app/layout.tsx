import type { Metadata } from "next";
import localFont from "next/font/local";
import { SiteHeader } from "../components/site-header";
import { siteUrl } from "../lib/site-url";
import { pageMetadata } from "../lib/page-metadata";
import "./globals.css";

const instrumentSans = localFont({
  src: "./fonts/instrument-sans-latin.woff2",
  variable: "--font-sans",
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
    "Tidy: Design and build in the same app",
    "A full design canvas in your browser, and a desktop app with your canvas, code and coding agents together. Open source under the Apache License 2.0.",
  ),
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${instrumentSans.className} ${instrumentSans.variable} ${instrumentSerif.variable}`}
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('tidy-theme');document.documentElement.dataset.theme=t==='dark'||t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}catch{document.documentElement.dataset.theme=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}`,
          }}
        />
      </head>
      <body>
        <a className="skip-link" href="#main-content">
          Skip to content
        </a>
        <SiteHeader />
        {children}
      </body>
    </html>
  );
}
