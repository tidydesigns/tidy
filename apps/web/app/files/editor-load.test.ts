import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("native editor load uses one authorized read and does not await optional rollout flags", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
      import { mock } from "bun:test";
      import { createElement } from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import { blankDesignDocument } from "@/lib/design/document";
      mock.module("server-only", () => ({}));
      const queries = [];
      let row = {
        id: "file", name: "Blank", organizationId: "org", organizationName: "Team",
        folderId: null, archivedAt: null, role: "editor",
        revision: 1, content: blankDesignDocument(),
      };
      mock.module("@/lib/db", () => ({ db: { query: async (sql, args) => {
        queries.push({ sql, args });
        return { rows: row ? [row] : [] };
      }, connect: () => { throw new Error("Unnecessary metadata transaction"); } } }));
      const { getEditorFile } = await import("./lib/design/document-service.ts");
      const loaded = await getEditorFile("viewer", "file");
      const nativeQueries = queries.splice(0);
      row = null;
      const missing = await getEditorFile("outsider", "file");
      const missingQueries = queries.splice(0);
      row = { ...loaded.file, ...loaded.document };
      const flags = new Promise(() => {});
      mock.module("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({get: () => undefined}) }));
      mock.module("@/lib/auth", () => ({ auth: { api: {getSession: async () => ({user:{id:"viewer",name:"Viewer"}})} } }));
      mock.module("@/lib/functional-feature-flags", () => ({ functionalFeatureFlags: () => flags }));
      const agentsConfig = { ...(await import("@/lib/agents/config")) };
      mock.module("@/lib/agents/config", () => ({ ...agentsConfig, agentsEnabled: () => false }));
      mock.module("@/app/files/[uid]/file-editor", () => ({ FileEditor: () => null }));
      const { default: Page } = await import("./app/files/[uid]/page.tsx");
      let timer;
      const page = await Promise.race([
        Page({params:Promise.resolve({uid:"file"}),searchParams:Promise.resolve({})}),
        new Promise((_,reject) => { timer = setTimeout(() => reject(new Error("Canvas waited for optional flags")), 1000); }),
      ]);
      clearTimeout(timer);
      const { DeferredFeatureFlagsProvider, useFeatureFlag } = await import("./lib/use-feature-flag.ts");
      function Probe() { return createElement("span", null, useFeatureFlag("github-connector") ? "enabled" : "disabled"); }
      const pendingMarkup = renderToStaticMarkup(createElement(DeferredFeatureFlagsProvider,{flags},createElement(Probe)));
      console.log(JSON.stringify({ nativeQueries, missing, missingQueries,
        flagsDeferred: page.props.flags === flags,
        fileId: page.props.children.props.children.props.fileId,
        pendingMarkup,
      }));
    `,
    ],
    { cwd: resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
  );
  expect({ exitCode: child.exitCode, stderr: child.stderr.toString() }).toEqual({
    exitCode: 0,
    stderr: "",
  });
  const result = JSON.parse(child.stdout.toString());
  expect(result.nativeQueries).toHaveLength(1);
  expect(result.nativeQueries[0].args).toEqual(["file", "viewer"]);
  expect(result.nativeQueries[0].sql).toContain('u."emailVerified"=true');
  expect(result.nativeQueries[0].sql).toContain('m."role" in');
  expect(result.missing).toBeNull();
  expect(result.missingQueries).toHaveLength(1);
  expect(result.flagsDeferred).toBe(true);
  expect(result.fileId).toBe("file");
  expect(result.pendingMarkup).toBe("<span>disabled</span>");
});
