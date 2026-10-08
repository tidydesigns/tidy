import { expect, mock, test } from "bun:test";
import React from "react";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { OrganizationNamesProvider } from "@/components/workspace/organization-names";
import type { Member } from "./settings-tabs";

mock.module("server-only", () => ({}));
const { MemberControls } = await import("./member-controls");
const { OrganizationMembership } = await import("./organization-membership");
const { SettingsTabs } = await import("./settings-tabs");
const { BillingSettings } = await import("./billing-settings");
const { UpgradeDialog } = await import("@/components/workspace/upgrade-dialog");
const members: Member[] = [
  {
    id: "owner-member",
    userId: "owner",
    role: "owner",
    name: "Owner",
    email: "owner@example.test",
  },
  {
    id: "admin-member",
    userId: "admin",
    role: "admin",
    name: "Admin",
    email: "admin@example.test",
  },
  {
    id: "member",
    userId: "member-user",
    role: "member",
    name: "Member",
    email: "member@example.test",
  },
];

test("member controls show role and removal actions only for members the viewer can manage", () => {
  const member = renderToStaticMarkup(
    <MemberControls
      organizationId="org"
      members={members}
      userId="member-user"
      role="member"
      onChange={() => {}}
    />,
  );
  expect(member).not.toContain("<select");
  expect(member).not.toContain("Remove member");
  const admin = renderToStaticMarkup(
    <MemberControls
      organizationId="org"
      members={members}
      userId="admin"
      role="admin"
      onChange={() => {}}
    />,
  );
  expect(admin).not.toContain("<select");
  expect(admin).toContain('aria-label="Role for Member: Editor"');
  expect(admin).not.toContain('aria-label="Role for Owner:');
  expect(admin).not.toContain('aria-label="Role for Admin:');
  expect(admin).not.toContain("Remove Owner?");
  const owner = renderToStaticMarkup(
    <MemberControls
      organizationId="org"
      members={members}
      userId="owner"
      role="owner"
      onChange={() => {}}
    />,
  );
  expect(owner).not.toContain("<select");
  expect(owner).toContain('aria-label="Role for Admin: Admin"');
  expect(owner).not.toContain("Remove Owner?");
});

test("the last owner has a handoff control before they can leave", () => {
  const owner = renderToStaticMarkup(
    <OrganizationMembership
      organization={{ id: "org", name: "Team" }}
      members={members}
      userId="owner"
      role="owner"
      onTransfer={() => {}}
    />,
  );
  expect(owner).toContain("Transfer ownership");
  expect(owner).toContain('aria-haspopup="menu"');
  expect(owner).not.toContain("<select");
  expect(owner).not.toContain("Leave organization");
  const member = renderToStaticMarkup(
    <OrganizationMembership
      organization={{ id: "org", name: "Team" }}
      members={members}
      userId="member-user"
      role="member"
      onTransfer={() => {}}
    />,
  );
  expect(member).toContain("Leave organization");
  expect(member).not.toContain("Transfer ownership");
});

test("profile renders editable identity, password and other session controls without exposing tokens", () => {
  const html = renderToStaticMarkup(
    <SearchParamsContext.Provider value={new URLSearchParams("tab=profile")}>
      <OrganizationNamesProvider>
        <SettingsTabs
          initialTab="profile"
          organization={{ id: "org", name: "Team" }}
          user={{ id: "owner", name: "Owner", email: "owner@example.test", emailVerified: false }}
          role="owner"
          canInvite
          members={members}
          github={{
            configured: false,
            ready: false,
            login: null,
            connections: [],
            installations: [],
            error: null,
            installUrl: "",
          }}
          linear={{ configured: false, ready: false, connections: [], error: null }}
          billing={{
            ready: false,
            tier: "free",
            plan: null,
            proLimits: null,
            status: null,
            currentPeriodEnd: null,
            cancelAtPeriodEnd: false,
            customerId: null,
            firstMonthUsed: false,
          }}
          sessions={[
            {
              id: "current",
              createdAt: "2026-09-28T12:00:00.000Z",
              expiresAt: "2026-10-01T12:00:00.000Z",
              userAgent: null,
              ipAddress: null,
            },
            {
              id: "other",
              createdAt: "2026-09-28T12:00:00.000Z",
              expiresAt: "2026-10-01T12:00:00.000Z",
              userAgent: "Chrome/1 Mac",
              ipAddress: "127.0.0.1",
            },
          ]}
          currentSessionId="current"
          emailConfigured
          verificationError={false}
        />
      </OrganizationNamesProvider>
    </SearchParamsContext.Provider>,
  );
  expect(html).toContain('value="Owner"');
  expect(html).toContain('value="owner@example.test"');
  expect(html).toContain("Verify your email");
  expect(html).toContain("Change password");
  expect(html).toContain("Appearance");
  expect(html).toContain('aria-haspopup="menu"');
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("System");
  expect(html).toContain("Editor panels");
  expect(html).toContain("Closed by default");
  expect(html).toContain("Applies to files opened in this browser.");
  expect(html).toContain("This session");
  expect(html).toContain("End session");
  expect(html).not.toContain('id="settings-tab-billing"');
  expect(html).not.toContain("Get Pro");
  expect(html).not.toContain("token");
});

test("the upgrade dialog offers checkout only to owners; billing settings manage existing plans", () => {
  const billing = {
    ready: true,
    tier: "free" as const,
    plan: null,
    proLimits: null,
    status: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    customerId: null,
    firstMonthUsed: false,
  };
  const upgrade = renderToStaticMarkup(
    <UpgradeDialog
      organizationId="org"
      owner
      firstMonthUsed={false}
      triggerClassName=""
      limits={{ files: null, editors: null, storageBytes: 10000000000, mcpCalls: 100000 }}
    />,
  );
  expect(upgrade).toContain(
    "Unlimited design files, all team members included, and 10 GB asset storage.",
  );
  expect(upgrade).toContain("$10 billed monthly");
  expect(upgrade).not.toContain("Annual");
  expect(upgrade).toContain("$5 for your first month");
  expect(upgrade).toContain("Continue with monthly Pro");
  const memberUpgrade = renderToStaticMarkup(
    <UpgradeDialog
      organizationId="org"
      owner={false}
      firstMonthUsed
      triggerClassName=""
      limits={{ files: null, editors: null, storageBytes: 10000000000, mcpCalls: 100000 }}
    />,
  );
  expect(memberUpgrade).toContain("Ask an organization owner to upgrade.");
  expect(memberUpgrade).not.toContain("Continue with monthly Pro");
  const owner = renderToStaticMarkup(
    <BillingSettings organizationId="org" owner billing={billing} />,
  );
  expect(owner).not.toContain("Get Pro");
  const pro = { ...billing, tier: "pro" as const, status: "active", customerId: "cus_123" };
  const managingOwner = renderToStaticMarkup(
    <BillingSettings organizationId="org" owner billing={pro} />,
  );
  expect(managingOwner).toContain("$10 USD per month");
  expect(managingOwner).toContain("Manage billing");
  const ending = renderToStaticMarkup(
    <BillingSettings
      organizationId="org"
      owner
      billing={{ ...pro, cancelAtPeriodEnd: true, currentPeriodEnd: "2026-10-30T20:47:37.000Z" }}
    />,
  );
  expect(ending).toContain("Pro ends");
  expect(ending).not.toContain("$10 USD per month");
  const member = renderToStaticMarkup(
    <BillingSettings organizationId="org" owner={false} billing={pro} />,
  );
  expect(member).not.toContain("Manage billing");
});

test("billing reflects configured allowances and identifies retained usage above a downgraded plan", () => {
  const html = renderToStaticMarkup(
    <BillingSettings
      organizationId="org"
      owner
      billing={{
        ready: false,
        tier: "free",
        status: "canceled",
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        customerId: null,
        firstMonthUsed: true,
        proLimits: { files: null, editors: null, storageBytes: 10000000000, mcpCalls: 100000 },
        plan: {
          tier: "free",
          limits: { files: 5, editors: 2, storageBytes: 1000000000, mcpCalls: 5000 },
          usage: { files: 6, editors: 1, storageBytes: 250000000, mcpCalls: 1250 },
          mcpResetAt: "2026-11-01T00:00:00Z",
        },
      }}
    />,
  );
  expect(html).toContain("6 / 5");
  expect(html).toContain("250 MB / 1 GB");
  expect(html).toContain("1,250 / 5,000");
  expect(html).toContain("3,750 remaining");
  expect(html).toContain("750 MB remaining");
  expect(html).toContain("1 over limit");
  expect(html.match(/role="progressbar"/g)).toHaveLength(4);
  expect(html).toContain('aria-valuenow="1250"');
  expect(html).toContain('aria-valuemax="5000"');
  expect(html).toContain("width:25%");
  expect(html).toContain("width:100%");
  expect(html).toContain("(UTC)");
  expect(html).toContain("Existing designs remain accessible");
  expect(html).not.toContain("Manage billing");
});
