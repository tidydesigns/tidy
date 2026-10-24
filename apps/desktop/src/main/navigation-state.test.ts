import { expect, test } from "bun:test";
import {
  emptyFileBrowser,
  fileBrowserSchema,
  readNavigation,
  workspaceTargetSchema,
  restoreWorkspaceTarget,
} from "../shared/navigation-state";

const stored = (value: string | null) => ({ getItem: () => value });

test("restores a cloud destination with its account and organization", () => {
  const target = { kind: "cloud", accountId: "account", organizationId: "second" } as const;
  expect(
    readNavigation(stored(JSON.stringify(target)), "workspace", workspaceTargetSchema, null),
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
    readNavigation(
      stored(JSON.stringify(browser)),
      "cloud:account:second",
      fileBrowserSchema,
      emptyFileBrowser,
    ),
  ).toEqual(browser);
});

test("missing, malformed and unavailable navigation storage falls back safely", () => {
  for (const value of [null, "{", '"invalid"', '{"folder":42}', '{"view":"invalid"}']) {
    expect(readNavigation(stored(value), "browser", fileBrowserSchema, emptyFileBrowser)).toEqual(
      emptyFileBrowser,
    );
  }
  expect(
    readNavigation(
      {
        getItem() {
          throw new Error("Storage unavailable");
        },
      },
      "browser",
      fileBrowserSchema,
      emptyFileBrowser,
    ),
  ).toEqual(emptyFileBrowser);
});

const account = {
  id: "account",
  organizations: [
    { id: "first", name: "First", canEdit: true },
    { id: "second", name: "Second", canEdit: true },
  ],
};
const cloudTarget = { kind: "cloud", accountId: "account", organizationId: "second" } as const;
const restore = (
  target: Parameters<typeof restoreWorkspaceTarget>[0]["target"],
  overrides: Partial<Parameters<typeof restoreWorkspaceTarget>[0]> = {},
) =>
  restoreWorkspaceTarget({
    target,
    account,
    changedAccount: false,
    navigated: false,
    ...overrides,
  });

test("refresh retains a local workspace and a non-default cloud organization", () => {
  expect(restore({ kind: "local" })).toEqual({ kind: "local" });
  expect(restore(cloudTarget)).toBe(cloudTarget);
  expect(restore(null)).toEqual({ kind: "cloud", accountId: "account", organizationId: "first" });
});

test("restoration falls back when edit access was removed and never inherits another account's destination", () => {
  expect(
    restore(cloudTarget, { account: { ...account, organizations: [account.organizations[0]] } }),
  ).toEqual({ kind: "local" });
  expect(restore(cloudTarget, { account: { id: "other", organizations: [] } })).toEqual({
    kind: "local",
  });
  expect(restore(cloudTarget, { account: { ...account, id: "other" } })).toEqual({
    kind: "cloud",
    accountId: "other",
    organizationId: "first",
  });
});

test("late cloud startup cannot override a navigation choice", () => {
  expect(restore(null, { navigated: true })).toBeNull();
  expect(restore({ kind: "local" }, { navigated: true })).toEqual({ kind: "local" });
});
