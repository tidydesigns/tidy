import { PrivacyPolicy } from "@tidy/ui/privacy-policy";
import "@tidy/ui/privacy-policy.css";
import { CloudFooter } from "../../components/brand/cloud-footer";
import { pageMetadata } from "../../lib/page-metadata";
import { appUrl, repositoryUrl } from "../../lib/site-links";

export const metadata = pageMetadata(
  "/privacy",
  "Tidy privacy policy",
  "How the hosted Tidy service handles personal information, cookies and privacy requests.",
);

export default function PrivacyPage() {
  return (
    <>
      <main id="main-content" tabIndex={-1} className="page">
        <PrivacyPolicy accountUrl={new URL("/account/privacy", appUrl).href} />
      </main>
      <CloudFooter appUrl={appUrl} repositoryUrl={repositoryUrl} />
    </>
  );
}
