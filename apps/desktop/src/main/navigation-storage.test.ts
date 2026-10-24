import { expect, test } from "bun:test";
import {
  emptyFileBrowser,
  fileBrowserSchema,
  workspaceTargetSchema,
} from "../shared/navigation-state";
import { readNavigation, writeNavigation } from "../shared/navigation-storage";

const stored = (value: string | null) => ({ getItem: () => value });

test("restores a cloud destination with its account and organization", () => {
  const target = { kind: "cloud", accountId: "account", organizationId: "second" } as const;
  expect(
    readNavigation({
      storage: stored(JSON.stringify(target)),
      key: "workspace",
      schema: workspaceTargetSchema,
      fallback: null,
    }),
  ).toEqual(target);
  expect(workspaceTargetSchema.safeParse({ kind: "cloud", organizationId: "second" }).success).toBe(
    false,
  );
});

test("restores the file and its containing browser context together", () => {
  const browser = {
    folder: "components",
    fileId: "design",
    query: "button",
    view: "list",
  } as const;
  expect(
    readNavigation({
      storage: stored(JSON.stringify(browser)),
      key: "cloud:account:second",
      schema: fileBrowserSchema,
      fallback: emptyFileBrowser,
    }),
  ).toEqual(browser);
});

test("missing, malformed and unavailable navigation storage falls back safely", () => {
  for (const value of [null, "{", '"invalid"', '{"folder":42}', '{"view":"invalid"}']) {
    expect(
      readNavigation({
        storage: stored(value),
        key: "browser",
        schema: fileBrowserSchema,
        fallback: emptyFileBrowser,
      }),
    ).toEqual(emptyFileBrowser);
  }
  expect(
    readNavigation({
      storage: {
        getItem() {
          throw new Error("Storage unavailable");
        },
      },
      key: "browser",
      schema: fileBrowserSchema,
      fallback: emptyFileBrowser,
    }),
  ).toEqual(emptyFileBrowser);
});

test("navigation writes are synchronous and scoped to the supplied key", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const value = { ...emptyFileBrowser, fileId: "selected-file" };
  writeNavigation({ storage, key: "cloud:account:second", value });
  expect(
    readNavigation({
      storage,
      key: "cloud:account:second",
      schema: fileBrowserSchema,
      fallback: emptyFileBrowser,
    }),
  ).toEqual(value);
  expect(
    readNavigation({
      storage,
      key: "cloud:other:second",
      schema: fileBrowserSchema,
      fallback: emptyFileBrowser,
    }),
  ).toEqual(emptyFileBrowser);
});

test("blocked or full storage cannot interrupt navigation", () => {
  expect(() =>
    writeNavigation({
      storage: {
        setItem() {
          throw new Error("Storage full");
        },
      },
      key: "workspace",
      value: { kind: "local" },
    }),
  ).not.toThrow();
});
