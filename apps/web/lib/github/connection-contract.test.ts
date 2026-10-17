import { expect, test } from "bun:test";
import { connectionStatusSchema, installationSchema } from "./connection-contract";

test("GitHub settings require complete connection state without rejecting unlinked accounts", () => {
  const connection = {
    configured: false,
    ready: false,
    login: null,
    connections: [],
    installations: [],
    error: null,
    installUrl: "https://github.com/apps/tidy/installations/new",
  };
  expect(connectionStatusSchema.parse(connection)).toEqual(connection);
  expect(
    connectionStatusSchema.safeParse({ ...connection, installations: [{ id: 1 }] }).success,
  ).toBe(false);
  expect(connectionStatusSchema.safeParse({ error: "Access ended." }).success).toBe(false);
});

test("installation payloads accept unavailable accounts without accepting invalid login types", () => {
  const installation = { id: 9, app_id: 12345, suspended_at: null };
  for (const account of [null, {}, { login: "tidydesigns" }])
    expect(installationSchema.parse({ ...installation, account }).account).toEqual(account);
  expect(installationSchema.safeParse({ ...installation, account: { login: 42 } }).success).toBe(
    false,
  );
});
