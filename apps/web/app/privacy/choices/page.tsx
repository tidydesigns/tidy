import Link from "next/link";
import { PrivacyChoices } from "@/components/privacy/privacy-choices";
import { TidyLogo } from "@/components/ui/tidy-logo";

export const metadata = { title: "Privacy choices · Tidy" };

export default function PrivacyChoicesPage() {
  return (
    <main className="mx-auto max-w-2xl space-y-8 px-6 py-12">
      <TidyLogo />
      <PrivacyChoices />
      <Link href="/" className="inline-block text-sm underline underline-offset-4">
        Back to Tidy
      </Link>
    </main>
  );
}
