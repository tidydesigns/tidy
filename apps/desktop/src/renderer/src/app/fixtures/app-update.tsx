import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import type { DesktopAPI } from "../../../../shared/contracts/desktop";
import type { AppUpdateState } from "../../../../shared/contracts/app-updates";
import { AppUpdate } from "../../features/updates/app-update";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

export async function runAppUpdateTests(root: Root) {
  const host = document.getElementById("root")!;
  const initial = deferred<AppUpdateState>();
  let snapshot = initial.promise;
  let emit: (state: AppUpdateState) => void = () => {};
  let checks = 0;
  let installs = 0;
  let rejectCheck = false;
  const api: DesktopAPI = {
    ...window.tidy!,
    updateState: () => snapshot,
    onUpdate: (listener) => {
      emit = (value) => flushSync(() => listener(value));
      return () => {};
    },
    checkUpdates: async () => {
      checks++;
      if (rejectCheck) throw new Error("private native diagnostics");
    },
    installUpdate: async () => {
      installs++;
      throw new Error("private signing diagnostics");
    },
  };
  flushSync(() => root.render(<AppUpdate api={api} />));
  const button = () => {
    const value = host.querySelector<HTMLButtonElement>(".app-update-button");
    check(value, "Update control disappeared");
    return value;
  };
  const badge = () => host.querySelector(".app-update-badge");
  const click = () => flushSync(() => button().click());
  check(!badge(), "An unresolved update snapshot advertised an available update");
  emit({ status: "idle" });
  initial.resolve({ status: "ready", version: "old-snapshot" });
  await settle();
  check(!badge(), "A stale snapshot replaced a newer idle event");
  check(button().getAttribute("aria-label") === "Check for updates", "Idle check unavailable");

  snapshot = Promise.resolve({ status: "idle" });
  click();
  check(button().getAttribute("aria-busy") === "true", "Checking did not respond immediately");
  click();
  check(checks === 1 && installs === 0, "Checking triggered duplicate work or an installation");
  await settle();
  check(
    button().getAttribute("data-state") === "idle" && !badge(),
    "A native check without events left the button busy or advertised an update",
  );

  for (const status of ["checking", "downloading", "installing"] as const) {
    emit({ status, version: "0.1.0-beta.999" });
    check(button().getAttribute("aria-busy") === "true", `${status} did not show progress`);
    check(!badge(), `${status} showed a ready badge`);
    click();
    check(checks === 1 && installs === 0, `${status} allowed an overlapping action`);
  }
  emit({ status: "ready", version: "0.1.0-beta.999" });
  check(host.querySelector(".app-update-ready"), "A staged update did not show availability");
  click();
  check(button().getAttribute("aria-busy") === "true", "Restart did not respond immediately");
  await settle();
  check(Number(installs) === 1, "Ready action did not request installation once");
  check(
    button().getAttribute("aria-label") === "Retry restart to update" &&
      host.querySelector(".app-update-warning"),
    "Failed installation lost its retry action",
  );
  check(!host.textContent?.includes("private signing"), "Native diagnostics escaped into the UI");

  emit({ status: "unsupported" });
  check(!badge(), "An unsupported build advertised an available update");
  check(button().getAttribute("aria-disabled") === "true", "Unsupported updates were enabled");
  click();
  check(checks === 1 && Number(installs) === 1, "Unsupported updates executed a native action");

  emit({ status: "error", error: "check" });
  rejectCheck = true;
  click();
  await settle();
  check(
    button().getAttribute("aria-label") === "Retry update check" &&
      host.querySelector(".app-update-warning"),
    "Failed checks did not retain an actionable retry",
  );
  rejectCheck = false;
  emit({ status: "idle" });
  const late = deferred<AppUpdateState>();
  snapshot = late.promise;
  click();
  await settle();
  emit({ status: "ready", version: "0.1.0-beta.1000" });
  late.resolve({ status: "idle" });
  await settle();
  check(host.querySelector(".app-update-ready"), "A late check erased a newer available update");
}
