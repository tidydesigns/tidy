import { Icon } from "@/components/ui/icon";
import styles from "./onboarding.module.css";

const steps = ["Workspace", "Invite team", "Connect agent"];

export function OnboardingProgress({
  step,
  completed = false,
}: {
  step: 1 | 2 | 3;
  completed?: boolean;
}) {
  return (
    <nav aria-label="Onboarding progress" data-ph-public>
      <ol className="flex items-center gap-6 max-md:justify-between max-md:gap-2">
        {steps.map((label, index) => (
          <li
            key={label}
            aria-current={!completed && step === index + 1 ? "step" : undefined}
            data-complete={completed || index + 1 < step ? "" : undefined}
            className={`${styles.progressStep} flex items-center gap-2 whitespace-nowrap text-xs max-md:gap-1.5 max-md:text-[11px] max-[22.5rem]:gap-1 max-[22.5rem]:text-[10px]`}
          >
            <span
              aria-hidden="true"
              className={`${styles.progressNumber} flex size-6 shrink-0 items-center justify-center rounded-[7px] text-[11px]`}
            >
              {completed || index + 1 < step ? <Icon name="checkBold" size={16} /> : index + 1}
            </span>
            <span>{label}</span>
            {(completed || index + 1 < step) && <span className="sr-only">Complete</span>}
          </li>
        ))}
      </ol>
    </nav>
  );
}
