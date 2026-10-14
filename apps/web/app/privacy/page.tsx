import type { Metadata } from "next";
import { PrivacyPolicy } from "@tidy/ui/privacy-policy";
import { NavigationLink } from "@/components/ui/navigation-link";
import "@tidy/ui/privacy-policy.css";

export const metadata: Metadata = {
  title: "Privacy policy — Tidy",
  description:
    "How the hosted Tidy service handles personal information, cookies and privacy requests.",
};

export default function PrivacyPage() {
  return (
    <main className="px-6 py-8">
      <NavigationLink
        href="/login"
        className="inline-flex min-h-11 items-center text-sm underline underline-offset-4"
      >
        Back to Tidy
      </NavigationLink>
      <PrivacyPolicy accountUrl="/account/privacy" />
    </main>
  );
}
