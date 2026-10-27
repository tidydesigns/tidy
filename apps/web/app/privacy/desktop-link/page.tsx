import { Suspense } from "react";
import { DesktopLink } from "./desktop-link";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
export const metadata = {
  title: "Link desktop usage · Tidy",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};
export default async function DesktopLinkPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
    query: { disableCookieCache: true },
  });
  return (
    <Suspense>
      <DesktopLink account={session?.user.email ?? null} />
    </Suspense>
  );
}
