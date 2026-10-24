import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("consent distinguishes MCP login from cloud sync by the signed resource", () => {
  // Isolate page mocks from authentication and navigation tests in the suite.
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { mock, expect } from "bun:test";
    import { createElement } from "react";
    import { renderToStaticMarkup } from "react-dom/server";
    import { makeSignature } from "better-auth/crypto";
    const secret = crypto.randomUUID();
    const approvals = [];
    mock.module("server-only", () => ({}));
    mock.module("next/headers", () => ({ headers: async () => new Headers() }));
    mock.module("next/navigation", () => ({
      notFound() { throw new Error("not-found"); },
      redirect() { throw new Error("redirect"); },
    }));
    mock.module("@/lib/auth", () => ({ auth: {
      $context: Promise.resolve({ secret }),
      api: {
        getSession: async () => ({ user: { id: "user" }, session: { id: "session" } }),
        getOAuthClientPublic: async () => ({ client_name: "Test client" }),
      },
    } }));
    mock.module("@/lib/auth/oauth-consent", () => ({
      createConsentApproval: async (...args) => { approvals.push(args); return "approval"; },
    }));
    mock.module("@/components/auth/auth-shell", () => ({
      AuthShell: ({ title, description, children }) => createElement("main", null,
        createElement("h1", null, title), createElement("p", null, description), children),
    }));
    mock.module("@/app/mcp/consent/consent-choice", () => ({ ConsentChoice: () => null }));
    const { default: Page } = await import("./app/mcp/consent/page.tsx");
    async function signed(resource, scope) {
      const query = new URLSearchParams({
        client_id: "test-client",
        exp: String(Math.floor(Date.now() / 1000) + 300),
        redirect_uri: "http://127.0.0.1:1234/callback",
        scope,
      });
      if (resource) query.set("resource", resource);
      query.sort();
      query.set("sig", await makeSignature(query.toString(), secret));
      return query;
    }
    async function render(query) {
      return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(Object.fromEntries(query)) }));
    }
    for (const resource of [undefined, "https://example.test/api/mcp"]) {
      for (const scope of ["mcp:read offline_access", "desktop:sync mcp:read mcp:write offline_access"]) {
        const query = await signed(resource, scope);
        const html = await render(query);
        expect(html).toContain("Connect a coding agent");
        expect(html).toContain("Read organizations and design files");
        expect(html).not.toContain("Connect a desktop app");
        expect(html).not.toContain("Local projects stay on your computer");
        expect(approvals.at(-1)).toEqual(["user", "session", query.toString(), secret]);
      }
    }
    const cloud = await signed("https://example.test/api/desktop", "desktop:sync offline_access");
    const html = await render(cloud);
    expect(html).toContain("Connect a desktop app");
    expect(html).toContain("Local projects stay on your computer");
    expect(html).not.toContain("Connect a coding agent");
    expect(html).not.toContain("Read organizations and design files");
    expect(html).toContain("127.0.0.1:1234");
    const before = approvals.length;
    cloud.set("resource", "https://example.test/api/mcp");
    await expect(render(cloud)).rejects.toThrow("not-found");
    expect(approvals).toHaveLength(before);
    `,
    ],
    {
      cwd: resolve(import.meta.dir, "../../.."),
      env: { ...process.env, BETTER_AUTH_URL: "https://example.test" },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    },
  );
  expect({ exitCode: child.exitCode, stderr: child.stderr.toString() }).toEqual({
    exitCode: 0,
    stderr: "",
  });
});
