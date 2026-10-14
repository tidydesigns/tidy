import { PrivacyPolicy } from "@tidy/ui/privacy-policy";
import "@tidy/ui/privacy-policy.css";
import { SiteFooter } from "../../components/site-footer";
import { SiteHeader } from "../../components/site-header";
import { pageMetadata } from "../../lib/page-metadata";

export const metadata = pageMetadata(
  "/privacy",
  "Privacy policy — Tidy",
  "How the hosted Tidy service handles personal information, cookies and privacy requests.",
);

export default function PrivacyPage() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://app.tidydesign.co";
  return (
    <div className="page">
      <SiteHeader />
      <main>
        <PrivacyPolicy accountUrl={new URL("/account/privacy", appUrl).href} />
      </main>
      <SiteFooter />
    </div>
  );
}
