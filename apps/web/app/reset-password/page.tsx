import { NavigationLink as Link } from "@/components/ui/navigation-link";
import { AuthShell } from "@/components/auth/auth-shell";
import { ResetPasswordForm } from "./reset-form";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[]; error?: string | string[] }>;
}) {
  const query = await searchParams;
  const token =
    !query.error && typeof query.token === "string" && query.token.length <= 512
      ? query.token
      : null;
  return (
    <AuthShell title="Choose a new password." description="Use at least 8 characters.">
      {token ? (
        <ResetPasswordForm token={token} />
      ) : (
        <p role="alert" className="mt-8 text-sm">
          This reset link is invalid or expired.{" "}
          <Link
            href="/forgot-password"
            className="underline decoration-primary-orange underline-offset-4"
          >
            Request a new link
          </Link>
          .
        </p>
      )}
    </AuthShell>
  );
}
