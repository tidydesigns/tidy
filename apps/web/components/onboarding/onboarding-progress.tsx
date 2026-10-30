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
      <ol className={styles.progress}>
        {steps.map((label, index) => (
          <li
            key={label}
            aria-current={!completed && step === index + 1 ? "step" : undefined}
            data-complete={completed || index + 1 < step ? "" : undefined}
            className={styles.progressStep}
          >
            <span aria-hidden="true" className={styles.progressNumber}>
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
