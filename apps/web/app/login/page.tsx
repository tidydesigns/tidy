import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { LoginForm } from "./login-form";
import { authReturnPath, socialSignInError } from "@/lib/auth-return-path";
import { enabledSocialProviders } from "@/lib/auth-social";
import { authEmailConfigured } from "@/lib/auth-email";

export const metadata: Metadata = {
  title: "Log in — Tidy",
  description: "Log in to your Tidy workspace.",
  robots: { index: false },
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const params = await searchParams;
  const next = authReturnPath(params.next, "/");
  const session = await auth.api.getSession({ headers: await headers() });

  if (session) redirect(next);

  return (
    <LoginForm
      next={next}
      providers={enabledSocialProviders()}
      emailConfigured={authEmailConfigured()}
      initialError={socialSignInError(params.error)}
      accountDeleted={params.deleted === "1"}
    />
  );
}
