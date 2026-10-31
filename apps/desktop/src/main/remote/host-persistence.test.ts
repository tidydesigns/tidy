import { expect, test } from "bun:test";
import { hostPersistenceWarning } from "./host-persistence";

test("only a verified lingering user service promises persistence after logout", async () => {
  expect(await hostPersistenceWarning("systemd", async () => "yes")).toBeUndefined();
  expect(await hostPersistenceWarning("systemd", async () => "no")).toContain(
    "loginctl enable-linger",
  );
  expect(await hostPersistenceWarning("systemd", async () => "")).toContain(
    "could not be verified",
  );
  expect(
    await hostPersistenceWarning("systemd", async () => {
      throw new Error("Unavailable");
    }),
  ).toContain("could not be verified");
});

test("other startup modes explain their actual lifetime without querying lingering", async () => {
  const unexpected = async () => {
    throw new Error("A non-systemd host must not query loginctl");
  };
  expect(await hostPersistenceWarning("launchd", unexpected)).toContain("Logging out stops it");
  expect(await hostPersistenceWarning("detached", unexpected)).toContain("Reconnect");
});
