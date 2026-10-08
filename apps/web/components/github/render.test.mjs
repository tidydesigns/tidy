import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { blankDesignDocument, buildDrawnNode } from "../../lib/design/document";
import { DesignSnapshot } from "./design-snapshot";
import { ReviewControl } from "./review-control";
import { GitHubSettings } from "./connection-settings";

test("pinned designs render using shared layout/tokens and protected snapshot asset URLs", () => {
  const frame = {
    ...buildDrawnNode("frame", "artboard", null, { x: 100, y: 100, width: 400, height: 300 }),
    layout: "flex-column",
    gap: 12,
  };
  const label = {
    ...buildDrawnNode("label", "text", "frame", { x: 0, y: 0, width: 200, height: 30 }),
    text: "Pinned title",
    style: { colorToken: "brand" },
  };
  const image = {
    ...buildDrawnNode("image", "container", "frame", { x: 0, y: 0, width: 100, height: 100 }),
    type: "image",
    assetId: "00000000-0000-4000-8000-000000000001",
  };
  const html = renderToStaticMarkup(
    createElement(DesignSnapshot, {
      reviewId: "review",
      content: {
        ...blankDesignDocument(),
        tokens: { brand: "#ff5d00" },
        nodes: [frame, label, image],
      },
      frameId: "frame",
      selectedNode: "label",
      onSelect: () => {},
    }),
  );
  expect(html).toContain("Pinned title");
  expect(html).toContain("flex-direction:column");
  expect(html).toContain("color:#ff5d00");
  expect(html).toContain("/api/github/reviews/review/assets/00000000-0000-4000-8000-000000000001");
  expect(html).not.toContain("/api/assets/");
});
test("GitHub controls render without credentials or a migration, with no save actions", () => {
  const pending = {
    configured: false,
    ready: false,
    login: null,
    connections: [],
    installations: [],
    error: null,
    installUrl: "https://github.com/apps/fixture-github-app/installations/new",
  };
  const settings = renderToStaticMarkup(
    createElement(GitHubSettings, { organizationId: "org", canManage: true, initial: pending }),
  );
  expect(settings).toContain("awaiting its database migration");
  expect(settings).not.toContain("client_secret");
  const review = renderToStaticMarkup(
    createElement(ReviewControl, {
      fileId: "file",
      document: blankDesignDocument(),
      revision: 1,
      selectedIds: [],
      initial: { ready: false, reviews: [] },
      viewerId: "alice",
      disabled: false,
    }),
  );
  expect(review).toContain("Pull requests");
  expect(review).not.toContain(">Save<");
});
