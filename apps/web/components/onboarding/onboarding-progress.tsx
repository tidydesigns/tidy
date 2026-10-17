const steps = ["Create org", "Invite team", "Connect MCP"];

export function OnboardingProgress({ step }: { step: 1 | 2 | 3 }) {
  return (
    <nav aria-label="Onboarding progress" data-ph-public>
      <ol className="flex items-center gap-2 sm:gap-3">
        {steps.map((label, index) => (
          <li
            key={label}
            aria-current={step === index + 1 ? "step" : undefined}
            className="flex items-center gap-2 text-[10px] sm:text-xs"
          >
            {index > 0 && <span aria-hidden="true" className="mr-1 h-px w-3 bg-border sm:w-6" />}
            <span
              aria-hidden="true"
              className={`flex size-[22px] shrink-0 items-center justify-center rounded-full text-[10px] ${
                step === index + 1
                  ? "bg-[#ff5d00] text-[#1e1e1e]"
                  : "bg-subtle-fill text-secondary-ink"
              }`}
            >
              {index + 1}
            </span>
            <span className={step === index + 1 ? "" : "text-secondary-ink"}>{label}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}
