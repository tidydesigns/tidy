import { expect, mock, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { blankDesignDocument } from "@/lib/design/document";

mock.module("server-only", () => ({}));
// Preserve the named exports used by other test files in Bun's shared module graph.
const navigation = { ...(await import("next/navigation")) };
mock.module("next/navigation", () => ({
  ...navigation,
  useRouter: () => ({ refresh() {}, replace() {} }),
}));
const { FileEditor } = await import("./[uid]/file-editor");
const { FilesBrowser } = await import("./files-browser");
const { TeamInvites } = await import("../onboarding/team/team-invites");

test("viewer canvas keeps navigation and commenting without design tools", () => {
  const markup = renderToStaticMarkup(
    <FileEditor
      fileId="file"
      fileName="Design"
      organizationName="Team"
      backHref="/files"
      canEdit={false}
      viewerId="viewer"
      initialDocument={{ revision: 1, content: blankDesignDocument() }}
    />,
  );
  expect(markup).toContain('aria-label="Comment tool"');
  expect(markup).toContain('aria-label="Select tool"');
  expect(markup).not.toContain('aria-label="Frame tool"');
  expect(markup).not.toContain('aria-label="Rectangle tool"');
  expect(markup).not.toContain('aria-label="Text tool"');
  expect(markup).not.toContain('aria-label="Add image"');
  expect(markup).not.toContain('aria-label="Add page"');
  expect(markup).not.toContain('aria-label="Page options');
});

test("editors retain design creation tools", () => {
  const markup = renderToStaticMarkup(
    <FileEditor
      fileId="file"
      fileName="Design"
      organizationName="Team"
      backHref="/files"
      canEdit
      initialDocument={{ revision: 1, content: blankDesignDocument() }}
    />,
  );
  expect(markup).toContain('aria-label="Frame tool"');
  expect(markup).toContain('aria-label="Expand editor panels"');
  expect(markup).not.toContain('aria-label="File tools"');
  expect(markup).not.toContain('aria-label="Add page"');
});

test("viewer file browser has no create controls", () => {
  const markup = renderToStaticMarkup(
    <FilesBrowser
      files={[]}
      folders={[]}
      currentFolder={null}
      archived={false}
      asOf="2026-10-02"
      canEdit={false}
    />,
  );
  expect(markup).not.toContain("New file");
  expect(markup).not.toContain("New folder");
  expect(markup).toContain('aria-label="File view"');
});

test("invites default to viewer and show legacy invitations as editor", () => {
  const markup = renderToStaticMarkup(
    <TeamInvites
      actorRole="owner"
      organizationId="org"
      currentEmail="owner@example.com"
      onboarding={false}
      initialInvites={[{ id: "invite", email: "reviewer@example.com", role: "member" }]}
    />,
  );
  expect(markup).toContain("Viewer: can view and comment");
  expect(markup).toContain("Editor: can edit designs");
  expect(markup).toContain("every file in this workspace");
  expect(markup).not.toContain("Continue on my own");
});

test("editor uses one file actions menu instead of separate feedback controls", () => {
  for (const initialPanelsOpen of [true, false]) {
    const markup = renderToStaticMarkup(
      <FileEditor
        fileId="file"
        fileName="Design"
        organizationName="Team"
        backHref="/files"
        initialPanelsOpen={initialPanelsOpen}
        initialDocument={{ revision: 1, content: blankDesignDocument() }}
      />,
    );
    expect(markup.match(/aria-label="File actions"/g)).toHaveLength(1);
    expect(markup).not.toContain('aria-label="Send feedback"');
    if (initialPanelsOpen) {
      expect(markup).toContain('aria-label="Add page"');
      expect(markup).toContain('aria-label="Minimize editor panels"');
    } else {
      expect(markup).toContain('aria-label="Expand editor panels"');
    }
  }
});
