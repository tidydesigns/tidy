import { expect, test } from "bun:test";
import { connectionStatusSchema } from "./connection-contract";

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
