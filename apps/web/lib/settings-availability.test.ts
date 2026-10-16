import { expect, spyOn, test } from "bun:test";
import { notFound, redirect } from "next/navigation";
import { settingsAvailability } from "./settings-availability";

test("optional Settings checks fail independently and report no private error text", async () => {
  const records: string[] = [];
  const log = spyOn(console, "error").mockImplementation((message) =>
    records.push(String(message)),
  );
  try {
    for (const failing of ["agents", "billing"] as const) {
      const results = await Promise.all(
        (["agents", "billing"] as const).map((kind) =>
          settingsAvailability(`settings.${kind}_availability`, async () => {
            if (kind === failing) throw new Error("private SQL and credentials");
            return true;
          }),
        ),
      );
      expect(results).toEqual(failing === "agents" ? [false, true] : [true, false]);
    }
    expect(records.map((record) => JSON.parse(record))).toEqual([
      { event: "operation_failed", operation: "settings.agents_availability" },
      { event: "operation_failed", operation: "settings.billing_availability" },
    ]);
    expect(records.join("\n")).not.toMatch(/private|SQL|credentials/);
  } finally {
    log.mockRestore();
  }
});

test("expected unavailability does not produce a failure report", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await settingsAvailability("settings.billing_availability", async () => false)).toBe(
      false,
    );
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});

test("Settings availability preserves Next redirects and missing-resource handling", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const control of [() => redirect("/login"), () => notFound()]) {
      let thrown: unknown;
      try {
        control();
      } catch (error) {
        thrown = error;
      }
      await expect(
        settingsAvailability("settings.agents_availability", async () => {
          throw thrown;
        }),
      ).rejects.toBe(thrown);
    }
    expect(log).not.toHaveBeenCalled();
  } finally {
    log.mockRestore();
  }
});
