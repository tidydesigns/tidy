import { Icon } from "@tidy/editor/components/ui/icon";
import type { HarnessId } from "../../shared/contracts";
import { HarnessIcon } from "@tidy/ui/harness-icon";

export function ComposerIcon({
  name,
}: {
  name: "branch" | "machine" | "reference" | "star" | "search" | "effort";
}) {
  if (name === "effort") return <Icon name="settings" size={15} />;
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {name === "branch" && (
        <>
          <circle cx="6" cy="5" r="2.5" />
          <circle cx="6" cy="19" r="2.5" />
          <circle cx="18" cy="5" r="2.5" />
          <path d="M6 7.5v9M18 7.5c0 6-12 2-12 9" />
        </>
      )}
      {name === "machine" && (
        <>
          <rect x="3" y="4" width="18" height="13" rx="2" />
          <path d="M8 21h8m-4-4v4" />
        </>
      )}
      {name === "reference" && (
        <>
          <rect x="3" y="3" width="18" height="18" rx="3" />
          <path d="m3 16 5-5 5 5 3-3 5 5" />
          <circle cx="16" cy="8" r="1.5" />
        </>
      )}
      {name === "star" && (
        <path d="M12 3.4 14.8 9.1 21.1 10l-4.5 4.4 1 6.2-5.6-3-5.6 3 1-6.2L2.9 10l6.3-.9Z" />
      )}
      {name === "search" && (
        <>
          <circle cx="10" cy="10" r="7" />
          <path d="m15 15 6 6" />
        </>
      )}
    </svg>
  );
}

export function ModelProviderIcon({ harness }: { harness: HarnessId }) {
  return harness === "codex" ? (
    <span aria-hidden="true" className="model-provider-icon" />
  ) : (
    <HarnessIcon harness={harness} size={15} />
  );
}

export function ComposerChevron() {
  return (
    <svg
      aria-hidden="true"
      className="composer-chevron"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
    >
      <path
        d="m3.5 6 4.5 4 4.5-4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
