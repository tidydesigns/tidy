import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import {
  webCaptureSchema,
  type ExtensionAccount,
  type ImportResult,
  type WebCapture,
} from "@bella/design/web-capture";
import type { CaptureViewport } from "@bella/design/capture-effects";
import { BELLA_URL } from "../lib/config";
import type { Destination, ImportJob, Reply } from "../lib/messages";

export default defineBackground(() => {
  const setJob = (job: ImportJob) => browser.storage.session.set({ job });
  const getJob = async () =>
    (await browser.storage.session.get("job")).job as ImportJob | undefined;
  const ready = getJob().then(async (job) => {
    if (job?.state === "importing")
      await setJob({
        state: "error",
        userId: job.userId,
        tabId: job.tabId,
        error: "The import was interrupted. Check the destination file before copying again.",
      });
  });
  let starting = false;
  let finishingSelection = false;
  const api = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(`${BELLA_URL}/api/extension/${path}`, {
      method: body ? "POST" : "GET",
      credentials: "include",
      redirect: "error",
      cache: "no-store",
      headers: { "X-Tidy-Extension": "1", ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(body ? 25000 : 10000),
    });
    const theme = response.headers.get("X-Tidy-Theme");
    if (theme === "light" || theme === "dark" || theme === "system")
      await browser.storage.local.set({ theme }).catch(() => undefined);
    const data = await response.json().catch(() => {
      throw new Error("Tidy is unavailable. Try again.");
    });
    if (!response.ok)
      throw new Error(
        data && typeof data.error === "string" ? data.error : "Tidy is unavailable. Try again.",
      );
    return data as T;
  };
  const getCapture = async (job: ImportJob, mode: "page" | "element") => {
    const tabId = job.tabId;
    if (!job.documentId) throw new Error("Reopen the extension and start a new capture.");
    const target = { documentId: job.documentId, frameId: 0 };
    const prepared = (await browser.tabs.sendMessage(
      tabId,
      {
        type: "bella:prepare-capture",
      },
      target,
    )) as Reply<CaptureViewport>;
    if ("error" in prepared) throw new Error(prepared.error);
    let screenshot: string | undefined;
    const tab = await browser.tabs.get(tabId);
    // captureVisibleTab always captures the active tab. Do not accidentally capture another page.
    const active = (await browser.tabs.query({ active: true, windowId: tab.windowId }))[0];
    if (active?.id === tabId) {
      try {
        screenshot = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      } catch {
        /* DOM capture still works. */
      }
    }
    const stillActive = (await browser.tabs.query({ active: true, windowId: tab.windowId }))[0];
    if (stillActive?.id !== tabId) screenshot = undefined;
    const reply = (await browser.tabs.sendMessage(
      tabId,
      {
        type: "bella:capture",
        mode,
        screenshot,
        screenshotViewport: prepared.data,
      },
      target,
    )) as Reply<WebCapture>;
    if ("error" in reply) throw new Error(reply.error);
    return webCaptureSchema.parse(reply.data);
  };
  const runImport = async (job: ImportJob, mode: "page" | "element") => {
    try {
      await setJob({ ...job, state: "importing" });
      const account = await api<ExtensionAccount>("account");
      if (account.user.id !== job.userId || !job.destination)
        throw new Error("Your Tidy account changed. Choose the destination again.");
      const capture = await getCapture(job, mode);
      const result = await api<ImportResult>("import", {
        userId: job.userId,
        organizationId: job.destination.organizationId,
        fileId: job.destination.fileId,
        capture,
      });
      const importedUrl = new URL(`/files/${result.fileId}`, BELLA_URL);
      if (result.nodeIds?.[0]) importedUrl.searchParams.set("node", result.nodeIds[0]);
      await setJob({
        state: "done",
        tabId: job.tabId,
        userId: job.userId,
        url: importedUrl.href,
        warnings: result.warnings ?? capture.document.warnings,
      });
    } catch (error) {
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

  browser.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== browser.runtime.id || !message || typeof message !== "object") return;
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
      if (message.type === "bella:account") return await api<ExtensionAccount>("account");
      if (message.type === "bella:login") {
        await browser.tabs.create({ url: `${BELLA_URL}/login` });
        return true;
      }
      if (message.type === "bella:cancel") {
        const job = await getJob();
        if (job?.state === "selecting") {
          await browser.tabs.sendMessage(job.tabId, { type: "bella:stop" }).catch(() => undefined);
          await browser.storage.session.remove("job");
        }
        return true;
      }
      if (message.type === "bella:picked" || message.type === "bella:cancelled") {
        const job = await getJob();
        if (
          !job ||
          job.state !== "selecting" ||
          sender.tab?.id !== job.tabId ||
          sender.frameId !== 0 ||
          sender.documentId !== job.documentId
        )
          return;
        if (message.type === "bella:cancelled") {
          await browser.storage.session.remove("job");
          return true;
        }
        if (finishingSelection) return;
        finishingSelection = true;
        try {
          await runImport(job, "element");
          // Capture must finish before opening the popup, which obscures the source page.
          try {
            const tab = await browser.tabs.get(job.tabId);
            const [active] = await browser.tabs.query({ active: true, windowId: tab.windowId });
            if (active?.id === job.tabId)
              await browser.action.openPopup({ windowId: tab.windowId });
          } catch {
            // Older browsers or an unfocused window may refuse. The result remains in the popup.
          }
        } finally {
          finishingSelection = false;
        }
        return true;
      }
      if (message.type !== "bella:start" || !["page", "element"].includes(message.mode)) return;
      const existing = await getJob();
      if (existing && ["selecting", "importing"].includes(existing.state))
        throw new Error("Finish or cancel the current capture first.");
      const account = await api<ExtensionAccount>("account");
      const destination = message.destination as Destination;
      if (account.user.id !== destination?.userId)
        throw new Error("Your Tidy account changed. Reopen the extension.");
      const organization = account.organizations.find(
        (item) => item.id === destination.organizationId,
      );
      if (
        !organization ||
        (destination.fileId && !organization.files.some((file) => file.id === destination.fileId))
      )
        throw new Error("Choose an accessible design file.");
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
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
      const job: ImportJob = {
        state: message.mode === "element" ? "selecting" : "importing",
        tabId: tab.id,
        documentId,
        userId: account.user.id,
        destination,
      };
      if (message.mode === "element") {
        await setJob(job);
        try {
          const { theme } = await browser.storage.local.get("theme");
          await browser.tabs.sendMessage(
            tab.id,
            { type: "bella:pick", theme },
            { documentId, frameId: 0 },
          );
        } catch (error) {
          await browser.storage.session.remove("job");
          throw error;
        }
      } else await runImport(job, "page");
      return true;
    };
    handle()
      .then(
        (data) => respond({ data }),
        (error) =>
          respond({
            error: error instanceof Error ? error.message : "Could not complete this action.",
          }),
      )
      .finally(() => {
        if (message.type === "bella:start") starting = false;
      });
    return true;
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void getJob().then(async (job) => {
      if (job?.tabId === tabId && job.state === "selecting")
        await browser.storage.session.remove("job");
    });
  });
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (change.status !== "loading") return;
    void getJob().then(async (job) => {
      if (job?.tabId === tabId && job.state === "selecting")
        await browser.storage.session.remove("job");
    });
  });
});
