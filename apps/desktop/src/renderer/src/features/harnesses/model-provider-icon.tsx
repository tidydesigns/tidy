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
    <HarnessIcon harness={harness} size={15} />
  );
}
