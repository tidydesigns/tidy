import { NavigationLink as Link } from "@/components/ui/navigation-link";
import { AuthShell } from "@/components/auth/auth-shell";
import { authEmailConfigured } from "@/lib/auth-email";
import { ForgotPasswordForm } from "./reset-form";
import { headers } from "next/headers";

export default async function ForgotPasswordPage() {
  // Delivery configuration belongs to the running app, not its build environment.
  await headers();
  return (
    <AuthShell
      title="Reset your password."
      description="We’ll email you a link to choose a new password."
    >
      <ForgotPasswordForm emailConfigured={authEmailConfigured()} />
      <p className="mt-8 text-center text-sm">
        <Link href="/login" className="underline decoration-primary-orange underline-offset-4">
          Back to sign in
        </Link>
      </p>
    </AuthShell>
  );
}
