import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import type { DesktopAPI, HarnessId } from "../../../../shared/contracts/desktop";
import type { HarnessUsage as Usage } from "../../../../shared/contracts/harness-usage";
import { HarnessUsage } from "../../features/harnesses/harness-usage";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 30));
}
function required<T>(value: T | undefined | null, label: string): T {
  check(value, label);
  return value;
}
export async function runHarnessUsageTests(root: Root) {
  const host = required(document.getElementById("root"), "Root missing");
  const projectId = crypto.randomUUID();
  const usage: Usage = {
    account: { plan: "plus", workspace: "Studio", billing: "subscription" },
    windows: [
      { id: "weekly", name: "Weekly limit", usedPercent: 57, resetsAt: Date.now() / 1000 + 86400 },
    ],
    resets: { availableCount: 3, items: [{ id: "one", expiresAt: Date.now() / 1000 + 86400 }] },
    credits: { balance: "120", unlimited: false, hasCredits: true },
    state: "available",
    updatedAt: new Date(Date.now() - 120_000).toISOString(),
    usagePage: "subscription",
  };
  const reads: Array<{
    harness: HarnessId;
    resolve(value: Usage): void;
    reject(error: Error): void;
  }> = [];
  const opened: Array<[HarnessId, string]> = [];
  const native = required(window.tidy, "Native API missing");
  const api: DesktopAPI = {
    ...native,
    harnessUsage: (_project, harness) =>
      new Promise((resolve, reject) => reads.push({ harness, resolve, reject })),
    openHarnessUsage: async (harness, page) => {
      opened.push([harness, page]);
    },
  };
  let harness: HarnessId = "codex";
  function render(initial: Usage | undefined, ready = true, modelId?: string) {
    flushSync(() =>
      root.render(
        <div style={{ padding: 24, marginTop: 400 }}>
          <HarnessUsage
            key={harness}
            api={api}
            projectId={projectId}
            harness={harness}
            modelId={modelId}
            ready={ready}
            initial={initial}
            tokens={{ inputTokens: 100, outputTokens: 20, cachedInputTokens: 60, costUSD: 0.0042 }}
          />
        </div>,
      ),
    );
  }
  const trigger = () =>
    required(
      host.querySelector<HTMLButtonElement>('[aria-label="Account & usage"]'),
      "Usage trigger missing",
    );
  const panel = () =>
    required(host.querySelector<HTMLElement>('[role="dialog"]'), "Usage panel missing");
  render(usage);
  flushSync(() => trigger().click());
  check(panel().textContent?.includes("43% left"), "Opening usage waited for its pending refresh");
  await settle();
  check(reads.length === 1, "Opening usage duplicated its pending preload");
  const conversation = required(
    [...panel().querySelectorAll("summary")].find((item) =>
      item.textContent?.includes("This conversation"),
    ),
    "Conversation disclosure missing",
  );
  flushSync(() => conversation.click());
  check(
    conversation.parentElement?.hasAttribute("open"),
    "Conversation details did not expand immediately",
  );
  check(
    panel().textContent?.includes("not a subscription charge"),
    "Subscription cost estimate could be mistaken for a bill",
  );
  reads[0].reject(new Error("private CLI error"));
  await settle();
  check(
    panel().textContent?.includes("43% left") && panel().textContent?.includes("last-known"),
    "Failed refresh erased available limits",
  );
  check(
    conversation.parentElement?.hasAttribute("open"),
    "Background refresh collapsed the active disclosure",
  );
  check(
    !panel().textContent?.includes("private CLI error"),
    "Raw native errors escaped into the UI",
  );
  const refresh = required(
    panel().querySelector<HTMLButtonElement>('[aria-label="Refresh account usage"]'),
    "Refresh missing",
  );
  flushSync(() => refresh.click());
  await settle();
  check(Number(reads.length) === 2, "Manual retry did not refetch");
  const codexRequest = reads[1];
  harness = "claude";
  render({
    ...usage,
    account: { plan: "max", billing: "subscription" },
    windows: [],
    resets: undefined,
    credits: undefined,
  });
  flushSync(() => trigger().click());
  await settle();
  codexRequest.resolve({
    ...usage,
    account: { plan: "private-old-account", billing: "subscription" },
  });
  await settle();
  check(
    panel().textContent?.includes("Claude Max") &&
      !panel().textContent?.includes("private-old-account"),
    "Late Codex data leaked into the next provider",
  );
  check(
    !panel().textContent?.includes("Banked resets"),
    "An unavailable resets panel occupied space",
  );
  flushSync(() =>
    required(
      panel().querySelector<HTMLButtonElement>(".account-usage-manage"),
      "Provider action missing",
    ).click(),
  );
  await settle();
  check(opened.at(-1)?.[0] === "claude", "Provider action opened the wrong account");
  flushSync(() =>
    panel().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    ),
  );
  check(!host.querySelector('[role="dialog"]'), "Escape did not dismiss usage");
  check(document.activeElement === trigger(), "Escape did not restore focus");
  render(undefined, false);
  flushSync(() => trigger().click());
  check(
    !panel().textContent?.includes("Claude Max") && panel().textContent?.includes("Sign in"),
    "Sign-out retained the previous account's figures",
  );
  harness = "opencode";
  render({
    ...usage,
    account: { plan: "OpenCode Go", billing: "subscription" },
    resets: undefined,
    credits: undefined,
    windows: [{ id: "old", name: "5-hour limit", usedPercent: 100, resetsAt: 1 }],
    updatedAt: new Date().toISOString(),
  });
  flushSync(() => trigger().click());
  check(
    panel().textContent?.includes("Checking…") && !panel().textContent?.includes("100% left"),
    "An elapsed reset was presented as recovered capacity",
  );
  const outside = document.createElement("button");
  document.body.append(outside);
  try {
    flushSync(() => outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    check(!host.querySelector('[role="dialog"]'), "Click-away did not dismiss usage");
  } finally {
    outside.remove();
  }
  render(usage, true, "openai/gpt-model");
  flushSync(() => trigger().click());
  check(
    !panel().querySelector('[role="meter"]') && panel().textContent?.includes("model's provider"),
    "Console allowances were attributed to another OpenCode provider",
  );
  harness = "codex";
  const beforeDeadline = reads.length;
  render({
    ...usage,
    updatedAt: new Date().toISOString(),
    windows: [
      {
        id: "expiring",
        name: "5-hour limit",
        usedPercent: 100,
        resetsAt: (Date.now() + 150) / 1000,
      },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 350));
  check(
    reads.length === beforeDeadline + 1,
    "A closed usage trigger didn't refresh at its reset deadline",
  );
  check(
    !trigger().textContent?.includes("0% left"),
    "The closed trigger retained an elapsed allowance",
  );
}
