import { expect, spyOn, test } from "bun:test";
import type { DesktopAPI } from "../../../shared/contracts/desktop";

test("repository requests explain a stale development server without hiding other failures", async () => {
  const globals = new Map<string, PropertyDescriptor | undefined>();
  const browser: { tidy?: DesktopAPI } = {};
  for (const [key, value] of Object.entries({ window: browser, location: { hash: "" } })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const fetch = spyOn(globalThis, "fetch");
  try {
    await import("./browser-api");
    const api = browser.tidy!;
    for (const request of [
      () => api.repositoryDirectory!("project", ""),
      () => api.repositoryChanges!("project"),
      () => api.repositoryFile!("project", "file.txt"),
    ]) {
      fetch.mockResolvedValueOnce(Response.json({ ok: false, error: "Unknown desktop request." }));
      await expect(request()).rejects.toThrow(
        "Repository files need a development server update. Restart the development server, then retry.",
      );
    }
    fetch.mockResolvedValueOnce(Response.json({ ok: false, error: "Unknown desktop request." }));
    await expect(api.repositoryContext!("project")).rejects.toThrow("Unknown desktop request.");
    fetch.mockResolvedValue(Response.json({ ok: false, error: "Project access denied." }));
    await expect(api.repositoryDirectory!("project", "")).rejects.toThrow("Project access denied.");
    fetch.mockResolvedValue(Response.json({ ok: true, data: { entries: [], limited: false } }));
    expect(await api.repositoryDirectory!("project", "")).toEqual({ entries: [], limited: false });
    const raw = { kind: "text", text: "whole file\n", view: "file", comparison: "none" } as const;
    fetch.mockResolvedValueOnce(Response.json({ ok: true, data: raw }));
    expect(await api.repositoryFile!("project", "file.txt", undefined, "file")).toEqual(raw);
    expect(JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body))).toEqual({
      name: "repository-file",
      input: { projectId: "project", path: "file.txt", view: "file" },
    });
    const timer = spyOn(globalThis, "setTimeout");
    try {
      timer.mockImplementationOnce(((callback: () => void) => {
        queueMicrotask(callback);
        return 0;
      }) as typeof setTimeout);
      fetch.mockReturnValueOnce(new Promise(() => {}));
      await expect(api.repositoryDirectory!("project", "")).rejects.toThrow("timed out");
      const signal = fetch.mock.calls.at(-1)?.[1]?.signal;
      expect(signal?.aborted).toBe(true);
      fetch.mockResolvedValueOnce(
        Response.json({ ok: true, data: { entries: [], limited: false } }),
      );
      expect(await api.repositoryDirectory!("project", "")).toEqual({
        entries: [],
        limited: false,
      });
    } finally {
      timer.mockRestore();
    }
  } finally {
    fetch.mockRestore();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
