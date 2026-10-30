import type { ReactNode } from "react";
import { TidyLogo } from "@/components/ui/tidy-logo";
import { NavigationLink } from "@/components/ui/navigation-link";
import { PrivacyChoicesButton } from "@/components/privacy/privacy-choices-button";
import { privacyPolicyUrl } from "@/lib/privacy-notice";

type AuthShellProps = {
  title: string;
  description: string;
  children: ReactNode;
};

export function AuthShell({ title, description, children }: AuthShellProps) {
  return (
    <main className="ph-no-capture auth-shell flex min-h-svh items-center justify-center px-6 pt-4 pb-9 max-sm:flex-col max-md:[&_input]:text-base max-md:[&_textarea]:text-base">
      <div className="relative w-full max-w-sm [overflow-wrap:anywhere]">
        <TidyLogo />
        <div className="auth-shell-heading mt-14">
          <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-2 text-sm text-secondary-ink">{description}</p>
        </div>
        {children}
        <NavigationLink
          href={privacyPolicyUrl}
          className="absolute inset-x-0 top-full mt-2 flex min-h-6 items-center justify-center text-sm text-secondary-ink underline underline-offset-4"
        >
          <span data-ph-public style={{ display: "contents" }}>
            Privacy policy
          </span>
        </NavigationLink>
      </div>
      <PrivacyChoicesButton className="fixed bottom-3 right-3 z-50 min-h-11 rounded-lg border border-border bg-panel px-3 text-xs text-secondary-ink hover:bg-hover-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink max-sm:static max-sm:mt-10" />
    </main>
  );
}
