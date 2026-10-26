import { HarnessIcon } from "@tidy/ui/harness-icon";
import type { HarnessId } from "../../../../shared/contracts/desktop";
import openaiIcon from "./openai.svg";

export function ModelProviderIcon({ harness }: { harness: HarnessId }) {
  return harness === "codex" ? (
    <span
      aria-hidden="true"
      className="model-provider-icon inline-block size-[15px] shrink-0 bg-current"
      style={{ mask: `url("${openaiIcon}") center / contain no-repeat` }}
    />
  ) : (
    <span className="model-provider-icon inline-flex size-[15px] shrink-0 items-center justify-center text-[light-dark(#9b5841,#ce9b82)]">
      <HarnessIcon harness={harness} size={14} />
    </span>
  );
}
