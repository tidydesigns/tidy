import { expect, test } from "bun:test";
import { restoreWorkspaceTarget } from "../shared/navigation-state";

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

test("startup navigation discards a cloud destination belonging to another account", () => {
  expect(
    restore(cloudTarget, {
      account: { ...account, id: "other" },
      navigated: true,
    }),
  ).toEqual({ kind: "local" });
  expect(restore(cloudTarget, { navigated: true })).toBe(cloudTarget);
});

test("a live account change resolves a new destination without inheriting the prior local choice", () => {
  expect(
    restore(
      { kind: "local" },
      {
        changedAccount: true,
        navigated: true,
        account: { ...account, id: "other" },
      },
    ),
  ).toEqual({ kind: "cloud", accountId: "other", organizationId: "first" });
});

test("read-only workspaces cannot be restored or selected as the default", () => {
  const readOnlyAccount = {
    ...account,
    organizations: account.organizations.map((organization) => ({
      ...organization,
      canEdit: false,
    })),
  };
  expect(restore(cloudTarget, { account: readOnlyAccount })).toEqual({ kind: "local" });
  expect(restore(null, { account: readOnlyAccount })).toEqual({ kind: "local" });
});
