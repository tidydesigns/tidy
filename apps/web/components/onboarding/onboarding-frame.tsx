import type { ReactNode } from "react";
import { TidyLogo } from "@/components/ui/tidy-logo";
import { OnboardingProgress } from "./onboarding-progress";
import styles from "./onboarding.module.css";

export function OnboardingFrame({
  step,
  completed = false,
  children,
}: {
  step?: 1 | 2 | 3;
  completed?: boolean;
  children: ReactNode;
}) {
  return (
    <main className={styles.page}>
      <div
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
        aria-hidden="true"
      >
        <div className={styles.atmosphere} />
        <div className={styles.coral} />
        <div className={styles.spectrum} />
      </div>
      <div className="mx-auto flex min-h-svh max-w-[1200px] flex-col px-12 pt-8 pb-7 max-md:p-6 max-[22.5rem]:px-5">
        <header className="flex min-h-11 flex-wrap items-center justify-between gap-6 max-md:gap-7 max-md:[&_nav]:w-full">
          <TidyLogo className="text-[38px] text-inherit" />
          {step && <OnboardingProgress step={step} completed={completed} />}
        </header>
        {children}
      </div>
    </main>
  );
}
