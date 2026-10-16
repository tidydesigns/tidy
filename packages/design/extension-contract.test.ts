import { expect, test } from "bun:test";
import { extensionAccountSchema, importJobSchema, readImportJob } from "./web-capture";

test("capture states require capture data and terminal jobs do not", () => {
  const identity = { userId: "user", tabId: 1 };
  for (const state of ["selecting", "importing"])
    expect(importJobSchema.safeParse({ ...identity, state }).success).toBe(false);
  expect(importJobSchema.safeParse({ ...identity, state: "done" }).success).toBe(false);
  expect(
    importJobSchema.safeParse({ ...identity, state: "error", error: "Interrupted" }).success,
  ).toBe(true);
  expect(
    importJobSchema.safeParse({ ...identity, state: "done", url: "https://app.example/files/file" })
      .success,
  ).toBe(true);
  expect(readImportJob({ ...identity, state: "selecting" })?.state).toBe("error");
  expect(readImportJob(null)).toBeUndefined();
  expect(readImportJob(undefined)).toBeUndefined();
});

test("account responses validate nested fields while accepting provider additions", () => {
  const account = { user: { id: "user", name: "User" }, organizations: [], added: true };
  expect(extensionAccountSchema.safeParse(account).success).toBe(true);
  expect(extensionAccountSchema.safeParse({ ...account, organizations: [{}] }).success).toBe(false);
  expect(extensionAccountSchema.safeParse(null).success).toBe(false);
});
