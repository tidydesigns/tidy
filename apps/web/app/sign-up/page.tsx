import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { SignUpForm } from "./sign-up-form";
import { authReturnPath, socialSignInError } from "@/lib/auth-return-path";
import { enabledSocialProviders } from "@/lib/auth-social";
import { authEmailConfigured } from "@/lib/auth-email";

export default async function SignUpPage({ searchParams }: PageProps<"/sign-up">) {
  const params = await searchParams;
  const next = authReturnPath(params.next, "/onboarding/organization");
  const session = await auth.api.getSession({ headers: await headers() });

  if (session) redirect(next);

  return (
    <SignUpForm
      next={next}
      providers={enabledSocialProviders()}
      emailConfigured={authEmailConfigured()}
      initialError={socialSignInError(params.error)}
    />
  );
}
