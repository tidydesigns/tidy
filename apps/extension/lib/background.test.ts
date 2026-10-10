import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ImportJob } from "./messages";
import { blankDesignDocument } from "@bella/design/document";

type Sender = {
  id: string;
  url?: string;
  tab?: { id: number };
  frameId?: number;
  documentId?: string;
};
type Listener = (
  message: Record<string, unknown>,
  sender: Sender,
  respond: (reply: unknown) => void,
) => unknown;
let listener: Listener;
let job: ImportJob | undefined;
let currentDocument = "source-document";
let activeTab = 7;
let accountId = "fixture-user";
let finishPost: (() => void) | undefined;
let postGate: Promise<void> | undefined;
const events: string[] = [];
const source = { id: 7, windowId: 1, url: "https://source.example/page" };
const id = "fixture-extension";
const capture = {
  title: "Fixture",
  url: source.url,
  mode: "element",
  document: {
    ...blankDesignDocument(),
    nodes: [
      {
        id: "frame",
        parentId: null,
        type: "artboard",
        name: "Frame",
        box: { x: 0, y: 0, width: 100, height: 100 },
        style: {},
        visible: true,
        locked: false,
        layout: "absolute",
      },
    ],
  },
  assets: [],
};
const browser = {
  runtime: {
    id,
    getURL: (path: string) => `chrome-extension://${id}/${path}`,
    onMessage: {
      addListener: (value: Listener) => {
        listener = value;
      },
    },
  },
  storage: {
    session: {
      get: async () => ({ job: job ? structuredClone(job) : undefined }),
      set: async (value: { job: ImportJob }) => {
        job = value.job;
        events.push(job.state);
      },
      remove: async () => {
        job = undefined;
      },
    },
    local: { get: async () => ({ theme: "dark" }), set: async () => {} },
  },
  tabs: {
    get: async () => source,
    query: async () => [{ ...source, id: activeTab }],
    create: async () => {},
    captureVisibleTab: async () => {
      events.push("screenshot");
      return "data:image/png;base64,fixture";
    },
    sendMessage: mock(
      async (_tab: number, message: { type: string }, target: { documentId?: string }) => {
        if (target.documentId !== currentDocument)
          throw new Error("Source document is no longer available.");
        events.push(message.type);
        if (message.type === "bella:prepare-capture")
          return { data: { width: 100, height: 100, scrollX: 0, scrollY: 0 } };
        return { data: capture };
      },
    ),
    onRemoved: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
  },
  scripting: { executeScript: async () => [{ documentId: currentDocument }] },
  action: {
    openPopup: mock(async () => {
      events.push("popup");
    }),
  },
};
mock.module("wxt/browser", () => ({ browser }));
mock.module("wxt/utils/define-background", () => ({
  defineBackground: (main: () => void) => main,
}));
const { default: initialize } = await import("../entrypoints/background");
const originalFetch = globalThis.fetch;
const fetchMock = mock(async (url: string | URL | Request, options?: RequestInit) => {
  if (String(url).endsWith("/account"))
    return Response.json({
      user: { id: accountId, name: "Fixture" },
      organizations: [{ id: "fixture-org", name: "Fixture", files: [] }],
    });
  events.push("post");
  expect(options?.signal).toBeInstanceOf(AbortSignal);
  await postGate;
  return Response.json({
    fileId: "00000000-0000-4000-8000-000000000001",
    nodeIds: ["frame"],
    warnings: [],
  });
});
const popup = { id, url: `chrome-extension://${id}/popup.html` };
const content = { id, tab: { id: source.id }, frameId: 0, documentId: "source-document" };
const send = (message: Record<string, unknown>, sender: Sender = popup) =>
  new Promise<unknown>((resolve) => listener(message, sender, resolve));
const start = () =>
  send({
    type: "bella:start",
    mode: "element",
    destination: { userId: accountId, organizationId: "fixture-org" },
  });

beforeEach(() => {
  job = undefined;
  currentDocument = "source-document";
  activeTab = source.id;
  accountId = "fixture-user";
  events.length = 0;
  postGate = undefined;
  finishPost = undefined;
  fetchMock.mockClear();
  browser.tabs.sendMessage.mockClear();
  browser.action.openPopup.mockClear();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  (initialize as unknown as () => void)();
});
afterEach(() => {
  finishPost?.();
  globalThis.fetch = originalFetch;
});

describe("extension import authority and lifecycle", () => {
  test("handles non-JSON server responses with a useful message", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("Unavailable", { status: 502 }));
    expect(await send({ type: "bella:account" })).toEqual({
      error: "Tidy is unavailable. Try again.",
    });
  });
  test("rejects unrelated senders before doing account or capture work", () => {
    const respond = mock(() => {});
    expect(listener({ type: "bella:account" }, { id: "other-extension" }, respond)).toBeUndefined();
    expect(listener({ type: "bella:account" }, { id, url: source.url }, respond)).toBeUndefined();
    expect(listener({ type: "bella:start" }, content, respond)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  test("captures the original document once and opens the popup only after completion", async () => {
    await start();
    expect(job?.documentId).toBe("source-document");
    await send({ type: "bella:picked" }, { ...content, documentId: "stale-document" });
    expect(job?.state).toBe("selecting");
    postGate = new Promise<void>((resolve) => {
      finishPost = resolve;
    });
    const first = send({ type: "bella:picked" }, content);
    const second = send({ type: "bella:picked" }, content);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.filter((event) => event === "post")).toHaveLength(1);
    expect(browser.action.openPopup).not.toHaveBeenCalled();
    finishPost!();
    await Promise.all([first, second]);
    expect(job?.state).toBe("done");
    expect(events.indexOf("screenshot")).toBeLessThan(events.indexOf("post"));
    expect(events.indexOf("done")).toBeLessThan(events.indexOf("popup"));
    expect(browser.action.openPopup).toHaveBeenCalledTimes(1);
  });
  test("navigation fails without importing a different document", async () => {
    await start();
    currentDocument = "new-document";
    await send({ type: "bella:picked" }, content);
    expect(job?.state).toBe("error");
    expect(events).not.toContain("post");
    expect(events).not.toContain("screenshot");
  });
  test("an account change prevents capturing or posting", async () => {
    await start();
    accountId = "another-user";
    await send({ type: "bella:picked" }, content);
    expect(job?.state).toBe("error");
    expect(events).not.toContain("post");
    expect(events).not.toContain("screenshot");
  });
  test("switching tabs does not reopen the popup over unrelated work", async () => {
    await start();
    activeTab = 8;
    await send({ type: "bella:picked" }, content);
    expect(job?.state).toBe("done");
    expect(events).not.toContain("popup");
    expect(events).not.toContain("screenshot");
  });
});
