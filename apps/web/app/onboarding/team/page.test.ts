import { expect, test } from "bun:test";

// Keep auth and Next request mocks isolated from the rest of the suite.
test("team onboarding redirects non-managers before loading invitations", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
      import { mock } from "bun:test";
      import assert from "node:assert/strict";
      let signedIn = true, role = "owner", organizationReads = 0;
      let releaseRole, releaseInvites;
      const calls = [];
      mock.module("next/headers", () => ({ headers: async () => new Headers() }));
      mock.module("next/navigation", () => ({ redirect: (href) => { throw new Error("redirect:" + href); } }));
      mock.module("@/components/onboarding/onboarding-shell", () => ({ OnboardingShell: () => null }));
      mock.module("./app/onboarding/team/team-invites", () => ({ TeamInvites: () => null }));
      mock.module("@/lib/auth", () => ({ auth: { api: {
        getSession: async () => signedIn ? { user: { email: "test@example.test" } } : null,
        listOrganizations: async () => { organizationReads++; return [{ id: "first", name: "First" }, { id: "selected", name: "Selected" }]; },
        getActiveMemberRole: ({ query }) => { calls.push(["role", query.organizationId]); return new Promise(resolve => { releaseRole = () => resolve({ role }); }); },
        listInvitations: ({ query }) => {
          if (!["owner", "admin"].includes(role)) throw new Error("invitation-read-forbidden");
          calls.push(["invitations", query.organizationId]); return new Promise(resolve => { releaseInvites = () => resolve([
          { id: "pending", email: "invite@example.test", role: "viewer", status: "pending", expiresAt: new Date(Date.now() + 60000) },
          { id: "expired", status: "pending", expiresAt: new Date(0) },
          { id: "accepted", status: "accepted", expiresAt: new Date(Date.now() + 60000) },
        ]); }); },
      } } }));
      const { default: TeamPage } = await import("./app/onboarding/team/page");
      const load = () => TeamPage({ searchParams: Promise.resolve({ organizationId: "selected" }) });
      const page = load();
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.deepEqual(calls, [["role", "selected"]]);
      releaseRole();
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.deepEqual(calls, [["role", "selected"], ["invitations", "selected"]]);
      releaseInvites();
      const result = await page;
      assert.equal(result.props.children.props.organizationId, "selected");
      assert.deepEqual(result.props.children.props.initialInvites.map(item => item.id), ["pending"]);
      for (const deniedRole of ["viewer", "editor", "member", "unknown"]) {
        role = deniedRole;
        const invitationReads = calls.filter(([kind]) => kind === "invitations").length;
        const denied = assert.rejects(load(), error => error.message === "redirect:/");
        await new Promise(resolve => setTimeout(resolve, 0));
        releaseRole();
        await denied;
        assert.equal(calls.filter(([kind]) => kind === "invitations").length, invitationReads);
      }
      signedIn = false;
      const before = organizationReads;
      await assert.rejects(load(), /redirect:\\/login/);
      assert.equal(organizationReads, before);
      `,
    ],
    { cwd: new URL("../../../", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  );
  expect(child.stderr.toString()).toBe("");
  expect(child.exitCode).toBe(0);
});
