import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("new files authorize in the displayed workspace and redirect without rendering the listing", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
      import { mock } from "bun:test";
      mock.module("server-only", () => ({}));
      let session = null;
      let organizations = [{ id: "fallback" }];
      let lookups = 0;
      let result = { id: "created/file" };
      const calls = [];
      const invalidations = [];
      mock.module("next/headers", () => ({ headers: async () => new Headers() }));
      mock.module("next/cache", () => ({ revalidatePath: path => invalidations.push(path) }));
      mock.module("@/lib/auth", () => ({ auth: { api: {
        getSession: async () => session,
        listOrganizations: async () => { lookups++; return organizations; },
      } } }));
      mock.module("@/lib/design/file-management", () => ({
        createBrowserFileForUser: async (...args) => { calls.push(args); return result; },
        duplicateFolderForUser() {}, duplicateFileForUser() {}, archiveFileForUser() {},
      }));
      const { isRedirectError } = await import("next/dist/client/components/redirect-error");
      const { getURLFromRedirectError } = await import("next/dist/client/components/redirect");
      const { createDesignFile } = await import("./app/files/actions.ts");
      async function create(...args) {
        try { return await createDesignFile(...args); }
        catch (error) {
          if (!isRedirectError(error)) throw error;
          return { redirect: getURLFromRedirectError(error) };
        }
      }
      const anonymous = await create(null, "displayed");
      session = { user: { id: "editor" }, session: { activeOrganizationId: "active" } };
      const created = await create("folder", "displayed");
      const active = await create();
      const lookupCountAfterActive = lookups;
      result = { error: "File or folder not found or access denied." };
      const denied = await create("foreign-folder", "untrusted");
      const invalidationsAfterDenied = [...invalidations];
      session.session.activeOrganizationId = null;
      result = { id: "fallback-file" };
      const fallback = await create();
      organizations = [];
      const missing = await create();
      console.log(JSON.stringify({ anonymous, created, active, lookupCountAfterActive, denied,
        invalidationsAfterDenied, fallback, missing, calls, invalidations, lookups }));
      `,
    ],
    { cwd: resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
  );
  expect({ exitCode: child.exitCode, stderr: child.stderr.toString() }).toEqual({
    exitCode: 0,
    stderr: "",
  });
  const result = JSON.parse(child.stdout.toString());
  expect(result.anonymous).toEqual({ error: "Sign in to create a file." });
  expect(result.created).toEqual({ redirect: "/files/created%2Ffile" });
  expect(result.active).toEqual(result.created);
  expect(result.lookupCountAfterActive).toBe(0);
  expect(result.denied).toEqual({ error: "File or folder not found or access denied." });
  expect(result.invalidationsAfterDenied).toEqual(["/files", "/files"]);
  expect(result.fallback).toEqual({ redirect: "/files/fallback-file" });
  expect(result.missing).toEqual({ error: "Create an organisation first." });
  expect(result.calls).toEqual([
    ["editor", "displayed", "folder"],
    ["editor", "active", null],
    ["editor", "untrusted", "foreign-folder"],
    ["editor", "fallback", null],
  ]);
  expect(result.invalidations).toEqual(["/files", "/files", "/files"]);
  expect(result.lookups).toBe(2);
});
