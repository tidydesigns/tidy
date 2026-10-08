import type { ReactNode } from "react";
import { TidyLogo } from "@/components/ui/tidy-logo";

type AuthShellProps = {
  title: string;
  description: string;
  children: ReactNode;
};

export function AuthShell({ title, description, children }: AuthShellProps) {
  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <TidyLogo />
        <div className="mt-14">
          <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-2 text-sm text-primary-black/70">{description}</p>
        </div>
        {children}
      </div>
    </main>
  );
}
