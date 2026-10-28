import { PrivacyPolicy } from "@tidy/ui/privacy-policy";
import "@tidy/ui/privacy-policy.css";
import { SiteFooter } from "../../components/site-footer";
import { pageMetadata } from "../../lib/page-metadata";

export const metadata = pageMetadata(
  "/privacy",
  "Tidy privacy policy",
  "How the hosted Tidy service handles personal information, cookies and privacy requests.",
);

export default function PrivacyPage() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://app.tidydesign.co";
  return (
    <div className="page">
      <main id="main-content" tabIndex={-1}>
        <PrivacyPolicy accountUrl={new URL("/account/privacy", appUrl).href} />
      </main>
      <SiteFooter />
    </div>
  );
}
