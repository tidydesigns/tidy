import type { ReactNode } from "react";
import { OnboardingFrame } from "./onboarding-frame";
import styles from "./onboarding.module.css";

export function OnboardingShell({
  step,
  title,
  replayTitle = false,
  description,
  replayDescription = false,
  children,
}: {
  step?: 1 | 2;
  title: string;
  replayTitle?: boolean;
  description: string;
  replayDescription?: boolean;
  children: ReactNode;
}) {
  return (
    <OnboardingFrame step={step}>
      <div className="flex flex-1 items-center justify-center py-16 max-md:py-12 [@media(max-height:700px)]:py-8">
        <div
          className={`${styles.form} w-full min-w-0 max-w-[420px] [overflow-wrap:anywhere] [&_button]:min-h-11 max-md:[&_input]:text-base max-md:[&_textarea]:text-base`}
        >
          <h1 data-ph-public={replayTitle || undefined} className={styles.title}>
            {title}
          </h1>
          <p data-ph-public={replayDescription || undefined} className={styles.description}>
            {description}
          </p>
          {children}
        </div>
      </div>
    </OnboardingFrame>
  );
}
