import type { Metadata } from "next";
import { NavigationLink as Link } from "@/components/ui/navigation-link";
import { AuthShell } from "@/components/auth/auth-shell";
import { ResetPasswordForm } from "./reset-form";

export const metadata: Metadata = {
  title: "Choose a new Tidy password",
  description: "Choose a new password for your Tidy account.",
  robots: { index: false },
};

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
          <span data-ph-public style={{ display: "contents" }}>
            This reset link is invalid or expired.
          </span>{" "}
          <Link
            href="/forgot-password"
            className="underline decoration-primary-orange underline-offset-4"
          >
            <span data-ph-public style={{ display: "contents" }}>
              Request a new link
            </span>
          </Link>
          <span data-ph-public style={{ display: "contents" }}>
            .
          </span>
        </p>
      )}
    </AuthShell>
  );
}
