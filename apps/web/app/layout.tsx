import type { Metadata } from "next";
import { Instrument_Sans } from "next/font/google";
import localFont from "next/font/local";
import { THEME_STORAGE_KEY } from "@/lib/theme";
import "./globals.css";

const instrumentSans = Instrument_Sans({
  variable: "--font-instrument-sans",
  subsets: ["latin"],
});
const instrumentSerif = localFont({
  src: "./fonts/InstrumentSerif-Regular.ttf",
  variable: "--font-instrument-serif",
  weight: "400",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Tidy",
  description: "Sign in to Tidy",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${instrumentSans.variable} ${instrumentSerif.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var theme=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(theme==="light"||theme==="dark")document.documentElement.dataset.theme=theme}catch{}`,
          }}
        />
      </head>
      <body className="min-h-full bg-primary-white font-sans text-primary-black">{children}</body>
    </html>
  );
}
