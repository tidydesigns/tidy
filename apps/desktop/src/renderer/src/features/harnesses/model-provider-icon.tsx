import { HarnessIcon } from "@tidy/ui/harness-icon";
import type { HarnessId } from "../../../../shared/contracts/desktop";
import openaiIcon from "./openai.svg";

export function ModelProviderIcon({ harness, size }: { harness: HarnessId; size?: number }) {
  return harness === "codex" ? (
    <span
      aria-hidden="true"
      className="model-provider-icon inline-block size-[15px] shrink-0 bg-current"
      style={{ width: size, height: size, mask: `url("${openaiIcon}") center / contain no-repeat` }}
    />
  ) : (
    <span
      className={`model-provider-icon inline-flex size-[15px] shrink-0 items-center justify-center ${harness === "claude" ? "text-[light-dark(#9b5841,#ce9b82)]" : ""}`}
      style={{ width: size, height: size }}
    >
      <HarnessIcon harness={harness} size={size ?? 14} />
    </span>
  );
}
