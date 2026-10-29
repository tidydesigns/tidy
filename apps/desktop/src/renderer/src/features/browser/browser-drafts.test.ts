import { expect, test } from "bun:test";
import {
  browserDraftKey,
  getBrowserDraft,
  reserveBrowserDraft,
  type BrowserDraftCache,
} from "./browser-drafts";

test("owner projects sharing an execution project keep separate draft previews", () => {
  const cache: BrowserDraftCache = new Map();
  const scope = {
    machineId: "local",
    projectId: "local-project",
    executionProjectId: "local-project",
  };
  const local = browserDraftKey(scope);
  const cloud = browserDraftKey({ ...scope, projectId: "cloud-project" });
  const remote = browserDraftKey({ ...scope, machineId: "remote" });
  const id = getBrowserDraft(cache, local);
  expect(getBrowserDraft(cache, cloud)).not.toBe(id);
  expect(getBrowserDraft(cache, remote)).not.toBe(id);
  expect(getBrowserDraft(cache, local)).toBe(id);
});

test("failed starts restore only their own current draft reservation", () => {
  const cache: BrowserDraftCache = new Map();
  const key = "draft";
  const first = getBrowserDraft(cache, key);
  const restoreFirst = reserveBrowserDraft(cache, key, first);
  expect(restoreFirst).toBeDefined();
  restoreFirst?.();
  expect(getBrowserDraft(cache, key)).toBe(first);
  const staleRestore = reserveBrowserDraft(cache, key, first);
  const second = getBrowserDraft(cache, key);
  expect(second).not.toBe(first);
  const restoreSecond = reserveBrowserDraft(cache, key, second);
  staleRestore?.();
  restoreSecond?.();
  expect(getBrowserDraft(cache, key)).toBe(second);
  reserveBrowserDraft(cache, key, second);
  expect(getBrowserDraft(cache, key)).not.toBe(second);
});
