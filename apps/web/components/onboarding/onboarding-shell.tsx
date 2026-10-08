import type { ReactNode } from "react";
import { TidyLogo } from "@/components/ui/tidy-logo";

export function OnboardingShell({
  step,
  title,
  description,
  children,
}: {
  step: 1 | 2;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-6 py-8 sm:px-10">
      <TidyLogo />
      <div className="flex flex-1 flex-col justify-center py-16">
        <div className="w-full max-w-md">
          <p className="text-xs font-semibold uppercase tracking-widest text-secondary-ink">
            Step {step} of 2
          </p>
          <h1 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
          <p className="mt-3 text-sm leading-6 text-secondary-ink">{description}</p>
          {children}
        </div>
      </div>
    </main>
  );
}
