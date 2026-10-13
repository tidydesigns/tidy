export const metadata = { title: "Account privacy · Tidy" };
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { PrivacyControls } from "./privacy-controls";
export default async function AccountPrivacyPage() {
  const requestHeaders = await headers();
  const account = await auth.api.getSession({
    headers: requestHeaders,
    query: { disableCookieCache: true },
  });
  if (!account) redirect("/login?next=/account/privacy");
  const organizations = await auth.api.listOrganizations({ headers: requestHeaders });
  if (organizations.length) redirect("/settings#account-data");
  return (
    <main className="mx-auto max-w-2xl px-6 py-12 pb-24">
      <a
        className="inline-flex min-h-9 items-center rounded-md text-sm font-medium text-secondary-ink hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-4"
        href="/settings"
      >
        Back to settings
      </a>
      <h1 className="my-8 text-3xl font-semibold">Account privacy</h1>
      <PrivacyControls email={account.user.email} />
    </main>
  );
}
