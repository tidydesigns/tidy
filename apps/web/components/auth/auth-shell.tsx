import type { ReactNode } from "react";
import { TidyLogo } from "@/components/ui/tidy-logo";
import { NavigationLink } from "@/components/ui/navigation-link";
import { privacyPolicyUrl } from "@/lib/privacy-notice";

type AuthShellProps = {
  title: string;
  description: string;
  children: ReactNode;
};

export function AuthShell({ title, description, children }: AuthShellProps) {
  return (
    <main className="auth-shell flex min-h-screen items-center justify-center px-6 pt-4 pb-9">
      <div className="relative w-full max-w-sm">
        <TidyLogo />
        <div className="auth-shell-heading mt-14">
          <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-2 text-sm text-primary-black/70">{description}</p>
        </div>
        {children}
        <NavigationLink
          href={privacyPolicyUrl}
          className="absolute inset-x-0 top-full mt-2 flex min-h-6 items-center justify-center text-sm text-secondary-ink underline underline-offset-4"
        >
          Privacy policy
        </NavigationLink>
      </div>
    </main>
  );
}
