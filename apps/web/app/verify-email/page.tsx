import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { authEmailConfigured } from "@/lib/auth-email";
import { authReturnPath } from "@/lib/auth-return-path";
import { AuthShell } from "@/components/auth/auth-shell";
import { VerificationForm } from "@/components/auth/verification-form";

export default async function VerifyEmailPage({ searchParams }: PageProps<"/verify-email">) {
  const params = await searchParams;
  const next = authReturnPath(params.next, "/");
  const session = await auth.api.getSession({ headers: await headers() });
  if (session) redirect(next);
  const error = params.error
    ? "This verification link is invalid or has expired. Request a new link below."
    : "";
  return (
    <AuthShell
      title="Verify your email."
      description="Open the link in your inbox to finish signing in."
    >
      <VerificationForm next={next} emailConfigured={authEmailConfigured()} initialError={error} />
    </AuthShell>
  );
}
