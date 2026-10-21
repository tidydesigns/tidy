import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("server public responses report the original value before selecting UI copy and preserve redirects", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { mock, expect } from "bun:test";
    mock.module("server-only", () => ({}));
    const captured = [];
    mock.module("@/lib/posthog-server", () => ({ createErrorReporter: () => async (error, details) => { captured.push({ error, details }); } }));
    const { actionError } = await import("./lib/action-error.ts");
    const { PublicActionError } = await import("./lib/security/public-error.ts");
    const original = Object.assign(new Error("private database details", { cause: new Error("connection reset") }), { code: "XX000" });
    const stack = original.stack;
    expect(actionError(original, "Could not create the file.")).toBe("Could not create the file.");
    expect(captured[0].error).toBe(original);
    expect(captured[0].details.operation).toBe("action.failed");
    expect(original.stack).toBe(stack);
    expect(original.cause.message).toBe("connection reset");
    expect(original.code).toBe("XX000");
    actionError(original, "Other fallback");
    expect(captured.length).toBe(1);
    expect(actionError(new PublicActionError("Enter a folder name."), "Fallback")).toBe("Enter a folder name.");
    const { redirect } = await import("next/navigation");
    let navigation;
    try { redirect("/files"); } catch (error) { navigation = error; }
    expect(() => actionError(navigation, "Fallback")).toThrow(navigation);
    expect(captured.length).toBe(2);
  `,
    ],
    {
      cwd: resolve(import.meta.dir, ".."),
      env: { ...process.env, NODE_ENV: "test" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
});
