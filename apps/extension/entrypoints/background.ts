import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import {
  webCaptureSchema,
  extensionAccountSchema,
  importResultSchema,
  extensionMessageSchema,
  readImportJob,
  readExtensionReply,
  captureViewportSchema,
  captureReceiptSchema,
  type Destination,
  parseExtensionResponse,
  type ImportJob,
} from "@tidy/design/web-capture";
import {
  PlatformError,
  readPlatformResponse,
  serializeCaptureRequest,
  platformRetryAfter,
} from "../lib/platform-api";
import { pageRequest } from "../lib/page-request";
import { TIDY_URL } from "../lib/config";

export default defineBackground(() => {
  const setJob = (job: ImportJob) => browser.storage.session.set({ job });
  const getJob = async () => readImportJob((await browser.storage.session.get("job")).job);
  const ready = getJob().then(async (job) => {
    if (job?.state !== "importing") return;
    if (job.submittedAt) {
      await setJob({
        state: "error",
        userId: job.userId,
        tabId: job.tabId,
        recovery: { id: job.captureId, createdAt: job.submittedAt },
        error: "Check the previous import status before copying again.",
      });
    } else
      await setJob({
        state: "error",
        userId: job.userId,
        tabId: job.tabId,
        error: "The capture was interrupted before upload. Copy the page again.",
      });
  });
  // Serialize job transitions, while capture and network work run outside the lock.
  let jobQueue: Promise<unknown> = Promise.resolve();
  const withJobLock = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = jobQueue.then(operation);
    jobQueue = result.catch(() => undefined);
    return result;
  };
  let activationVersion = 0;
  browser.tabs.onActivated.addListener(() => {
    activationVersion++;
  });
  let starting = false;
  let retryAt = 0;
  const api = async (path: string, body?: string): Promise<unknown> => {
    if (Date.now() < retryAt)
      throw new PlatformError(
        "Tidy asked us to wait before trying again.",
        429,
        Math.ceil((retryAt - Date.now()) / 1000),
      );
    const response = await fetch(`${TIDY_URL}/api/extension/${path}`, {
      method: body ? "POST" : "GET",
      credentials: "include",
      redirect: "error",
      cache: "no-store",
      headers: { "X-Tidy-Extension": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
      body,
      signal: AbortSignal.timeout(body ? 25000 : 10000),
    });
    const theme = response.headers.get("X-Tidy-Theme");
    if (theme === "light" || theme === "dark" || theme === "system")
      await browser.storage.local.set({ theme }).catch(() => undefined);
    const retryAfter = platformRetryAfter(response.headers.get("Retry-After"));
    if (response.status === 429 || response.status === 503)
      retryAt = Date.now() + Math.max(1, retryAfter) * 1000;
    const data = await readPlatformResponse(response);
    if (!response.ok)
      throw new PlatformError(
        data && typeof data === "object" && "error" in data && typeof data.error === "string"
          ? data.error.slice(0, 500)
          : "Tidy is unavailable. Try again.",
        response.status,
        retryAfter,
      );
    return data;
  };
  const checkDestination = async (destination: Destination) => {
    const query = new URLSearchParams({
      userId: destination.userId,
      organizationId: destination.organizationId,
    });
    if (destination.fileId) query.set("fileId", destination.fileId);
    return parseExtensionResponse(
      extensionAccountSchema.pick({ user: true }),
      await api(`account?${query}`),
    );
  };
  const completedJob = (
    userId: string,
    tabId: number,
    result: { fileId: string; nodeIds?: string[]; warnings?: { message: string }[] },
  ): ImportJob => {
    const url = new URL(`/files/${result.fileId}`, TIDY_URL);
    if (result.nodeIds?.[0]) url.searchParams.set("node", result.nodeIds[0]);
    return { state: "done", userId, tabId, url: url.href, warnings: result.warnings };
  };
  const recoverImport = async (
    userId: string,
    tabId: number,
    recovery: { id: string; createdAt: number },
  ): Promise<ImportJob> => {
    try {
      const receipt = parseExtensionResponse(
        captureReceiptSchema,
        await api(`import/${encodeURIComponent(recovery.id)}`),
      );
      if (receipt.state === "done") return completedJob(userId, tabId, receipt.result);
      if (receipt.state === "failed")
        return {
          state: "error",
          userId,
          tabId,
          error: "The import failed without publishing. Copy the page again.",
        };
    } catch {
      /* Keep the receipt identity; a failed lookup is not evidence of a failed commit. */
    }
    return {
      state: "error",
      userId,
      tabId,
      recovery,
      error: "The import result is not confirmed. Check its status before copying again.",
    };
  };
  const getCapture = async (
    job: Extract<ImportJob, { state: "selecting" | "importing" }>,
    mode: "page" | "element",
  ) => {
    const tabId = job.tabId;
    const target = { documentId: job.documentId, frameId: 0 };
    const prepared = parseExtensionResponse(
      captureViewportSchema,
      readExtensionReply(
        await pageRequest(
          browser.tabs.sendMessage(
            tabId,
            {
              type: "bella:prepare-capture",
              captureId: job.captureId,
            },
            target,
          ),
          5000,
        ),
      ),
    );
    let screenshot: string | undefined;
    const activation = activationVersion;
    const tab = await browser.tabs.get(tabId);
    // captureVisibleTab always captures the active tab. Do not accidentally capture another page.
    const active = (await browser.tabs.query({ active: true, windowId: tab.windowId }))[0];
    if (active?.id === tabId && prepared.screenshotSafe === true) {
      try {
        screenshot = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      } catch {
        /* DOM capture still works. */
      }
    }
    const stillActive = (await browser.tabs.query({ active: true, windowId: tab.windowId }))[0];
    if (stillActive?.id !== tabId || activation !== activationVersion) screenshot = undefined;
    const reply = readExtensionReply(
      await pageRequest(
        browser.tabs.sendMessage(
          tabId,
          {
            type: "bella:capture",
            captureId: job.captureId,
            mode,
            screenshot,
            screenshotViewport: prepared,
          },
          target,
        ),
      ),
    );
    return webCaptureSchema.parse(reply);
  };
  const runImport = async (
    job: Extract<ImportJob, { state: "selecting" | "importing" }>,
    mode: "page" | "element",
  ) => {
    let submittedAt: number | undefined;
    try {
      if (mode === "element") {
        const account = await checkDestination(job.destination);
        if (account.user.id !== job.userId)
          throw new Error("Your Tidy account changed. Choose the destination again.");
      }
      const capture = await getCapture(job, mode);
      const createdAt = Date.now();
      // Validate the byte limit before persisting an uncertain-submission state.
      const body = serializeCaptureRequest({
        request: { id: job.captureId, createdAt },
        userId: job.userId,
        organizationId: job.destination.organizationId,
        fileId: job.destination.fileId,
        capture,
      });
      await setJob({ ...job, state: "importing", submittedAt: createdAt });
      submittedAt = createdAt;
      const result = parseExtensionResponse(
        importResultSchema.pick({ fileId: true, nodeIds: true, warnings: true }),
        await api("import", body),
      );
      await setJob(
        completedJob(job.userId, job.tabId, {
          ...result,
          warnings: result.warnings ?? capture.document.warnings,
        }),
      );
    } catch (error) {
      const rejected =
        error instanceof PlatformError &&
        error.status !== undefined &&
        error.status >= 400 &&
        error.status < 500;
      if (submittedAt && !rejected) {
        await setJob(
          await recoverImport(job.userId, job.tabId, { id: job.captureId, createdAt: submittedAt }),
        );
        return;
      }
      await setJob({
        state: "error",
        tabId: job.tabId,
        userId: job.userId,
        error:
          error instanceof Error && error.name === "TimeoutError"
            ? "The import timed out. Check the destination file before trying again."
            : error instanceof Error
              ? error.message
              : "Could not import webpage.",
      });
    }
  };

  browser.runtime.onMessage.addListener((raw: unknown, sender, respond) => {
    if (sender.id !== browser.runtime.id) return;
    const input = extensionMessageSchema.safeParse(raw);
    if (!input.success) return;
    const message = input.data;
    const content = Boolean(sender.tab);
    if (content && !["bella:picked", "bella:cancelled"].includes(message.type)) return;
    if (!content && !sender.url?.startsWith(browser.runtime.getURL(""))) return;
    if (message.type === "bella:start") {
      if (starting) {
        respond({ error: "A capture is already starting." });
        return;
      }
      starting = true;
    }
    const handle = async () => {
      await ready;
      if (message.type === "bella:account") {
        const account = parseExtensionResponse(extensionAccountSchema, await api("account"));
        // Account/focus refresh can recover an acknowledged commit after a worker restart.
        void withJobLock(async () => {
          const job = await getJob();
          if (job?.state === "error" && job.recovery && job.userId === account.user.id)
            await setJob(await recoverImport(job.userId, job.tabId, job.recovery));
        }).catch(() => undefined);
        return account;
      }
      if (message.type === "bella:recover") {
        await withJobLock(async () => {
          const job = await getJob();
          if (job?.state === "error" && job.recovery)
            await setJob(await recoverImport(job.userId, job.tabId, job.recovery));
        });
        return true;
      }
      if (message.type === "bella:login") {
        await browser.tabs.create({ url: `${TIDY_URL}/login` });
        return true;
      }
      if (message.type === "bella:cancel") {
        await withJobLock(async () => {
          const job = await getJob();
          if (job?.state !== "selecting") return;
          // Release selection immediately; cleanup targets only its source document.
          await browser.storage.session.remove("job");
          void browser.tabs
            .sendMessage(
              job.tabId,
              { type: "bella:stop", captureId: job.captureId },
              {
                documentId: job.documentId,
                frameId: 0,
              },
            )
            .catch(() => undefined);
        });
        return true;
      }
      if (message.type === "bella:picked" || message.type === "bella:cancelled") {
        const job = await withJobLock(async () => {
          const current = await getJob();
          if (
            !current ||
            current.state !== "selecting" ||
            sender.tab?.id !== current.tabId ||
            sender.frameId !== 0 ||
            sender.documentId !== current.documentId ||
            message.captureId !== current.captureId
          )
            return;
          if (message.type === "bella:cancelled") {
            await browser.storage.session.remove("job");
            return;
          }
          const importing = { ...current, state: "importing" as const };
          await setJob(importing);
          return importing;
        });
        if (!job) return;
        await runImport(job, "element");
        // Capture must finish before opening the popup, which obscures the source page.
        try {
          const tab = await browser.tabs.get(job.tabId);
          const [active] = await browser.tabs.query({ active: true, windowId: tab.windowId });
          if (active?.id === job.tabId) await browser.action.openPopup({ windowId: tab.windowId });
        } catch {
          // Older browsers or an unfocused window may refuse. The result remains in the popup.
        }
        return true;
      }
      if (message.type !== "bella:start") return;
      // Pin the source before waiting on the account endpoint.
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      const job = await withJobLock(async () => {
        const existing = await getJob();
        if (existing && ["selecting", "importing"].includes(existing.state))
          throw new Error("Finish or cancel the current capture first.");
        if (
          !tab?.id ||
          !tab.url ||
          !/^https?:\/\//.test(tab.url) ||
          /^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/.test(tab.url)
        ) {
          throw new Error(
            "Open a website to copy. Chrome's internal pages and Web Store cannot be captured.",
          );
        }
        let documentId: string | undefined;
        try {
          const [injection] = await browser.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["/content-scripts/capture.js"],
          });
          documentId = injection?.documentId;
          if (!documentId) throw new Error("Could not identify the source document.");
        } catch {
          throw new Error("Chrome does not allow capture on this page.");
        }
        const destination = message.destination;
        const account = await checkDestination(destination);
        if (account.user.id !== destination.userId)
          throw new Error("Your Tidy account changed. Reopen the extension.");
        const job: Extract<ImportJob, { state: "selecting" | "importing" }> = {
          state: message.mode === "element" ? "selecting" : "importing",
          tabId: tab.id,
          documentId,
          captureId: crypto.randomUUID(),
          userId: account.user.id,
          destination,
        };
        if (message.mode === "element") {
          await setJob(job);
          try {
            const { theme } = await browser.storage.local.get("theme");
            await pageRequest(
              browser.tabs.sendMessage(
                tab.id,
                { type: "bella:pick", theme, captureId: job.captureId },
                { documentId, frameId: 0 },
              ),
              5000,
            );
          } catch (error) {
            await browser.storage.session.remove("job");
            throw error;
          }
        } else await setJob(job);
        return job;
      });
      if (message.mode === "page") await runImport(job, "page");
      return true;
    };
    handle()
      .then(
        (data) => respond({ data }),
        (error) =>
          respond({
            error: error instanceof Error ? error.message : "Could not complete this action.",
            status: error instanceof PlatformError ? error.status : undefined,
          }),
      )
      .finally(() => {
        if (message.type === "bella:start") starting = false;
      });
    return true;
  });

  const clearSelection = (tabId: number) => {
    void ready
      .then(() =>
        withJobLock(async () => {
          const job = await getJob();
          if (job?.tabId === tabId && job.state === "selecting")
            await browser.storage.session.remove("job");
        }),
      )
      .catch(() => undefined);
  };
  browser.tabs.onRemoved.addListener(clearSelection);
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status === "loading") clearSelection(tabId);
  });
});
