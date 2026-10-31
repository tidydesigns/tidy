import type { Metadata } from "next";
import { headers } from "next/headers";
import localFont from "next/font/local";
import { themeInitScript } from "@/lib/theme";
import "./globals.css";
import { NavigationRecoveryProvider } from "@/components/workspace/navigation-recovery";
import { ToastViewport } from "@tidy/ui/toast";
import { CookieConsent } from "@/components/privacy/cookie-consent";

const instrumentSans = localFont({
  src: "../../../packages/ui/fonts/instrument-sans-latin.woff2",
  variable: "--font-instrument-sans",
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
  title: "Tidy",
  description: "Sign in to Tidy",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const nonce = (await headers()).get("x-tidy-nonce") ?? undefined;
  return (
    <html
      lang="en"
      className={`${instrumentSans.variable} ${instrumentSerif.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: themeInitScript,
          }}
        />
      </head>
      <body className="min-h-full bg-primary-white font-sans text-primary-black">
        <NavigationRecoveryProvider>{children}</NavigationRecoveryProvider>
        <CookieConsent />
        <ToastViewport />
      </body>
    </html>
  );
}
