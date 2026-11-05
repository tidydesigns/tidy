import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ThreadCard } from "../../src/renderer/src/features/threads/thread-card";
import { CanvasArtwork } from "../../../../packages/editor/src/editor/canvas-artwork";
import { resolvedDocumentNodes, resolvedColorTokens } from "@tidy/design/design-tokens";
import type { DesignDocument, DesignNode } from "@tidy/design/document";
import { threadSummarySchema } from "../../src/shared/contracts/desktop";
import "@tidy/ui/fonts.css";
import "../../src/renderer/src/styles.css";

export type ThreadExample =
  | "empty"
  | "working"
  | "completed-response"
  | "completed-response-with-pr"
  | "done";

declare global {
  interface Window {
    canvasFidelity: {
      thread(example: ThreadExample): void;
      artwork(document: DesignDocument, assets: Record<string, string>): void;
    };
  }
}
const container = document.createElement("div");
container.id = "fixture";
document.body.append(container);
const root = createRoot(container);
const noop = () => {};
window.canvasFidelity = {
  thread(example) {
    const input = {
      id: "33333333-3333-4333-a333-333333333333",
      projectId: "44444444-4444-4444-a444-444444444444",
      title: example === "empty" ? "" : "Improve canvas tooling",
      designIds: [],
      harness: "codex",
      status: example === "working" ? "running" : example === "empty" ? "idle" : "completed",
      updatedAt: "2026-11-03T10:00:00Z",
      messageCount: example === "empty" ? 0 : 2,
      ...(example === "done" ? { doneAt: "2026-11-03T10:01:00Z" } : {}),
      ...(example === "completed-response-with-pr"
        ? { pullRequests: ["https://github.com/tidydesigns/tidy/pull/1"] }
        : {}),
    };
    const parsed = threadSummarySchema.safeParse(input);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    const thread = parsed.data;
    flushSync(() =>
      root.render(
        <ThreadCard
          thread={thread}
          selected={false}
          loaded={true}
          now={Date.parse("2026-11-03T10:02:00Z")}
          pending={false}
          onSelect={noop}
          onDone={noop}
          api={{ openChatLink: async () => {} }}
        />,
      ),
    );
  },
  artwork(document, assets) {
    const nodes = resolvedDocumentNodes(document);
    const children = new Map<string | null, DesignNode[]>();
    for (const node of nodes) {
      const list = children.get(node.parentId) ?? [];
      list.push(node);
      children.set(node.parentId, list);
    }
    flushSync(() =>
      root.render(
        <CanvasArtwork
          nodesById={new Map(nodes.map((node) => [node.id, node]))}
          childrenById={children}
          visibleRootIds={new Set(nodes.filter((node) => !node.parentId).map((node) => node.id))}
          registerElement={noop}
          tokens={resolvedColorTokens(document)}
          selectedIds={[]}
          prototypeMode={false}
          prototypeArtboardId={null}
          cropId={null}
          editingTextId={null}
          previewAssetUrls={assets}
          onMenu={noop}
          onDoubleClick={noop}
          onPointerDown={noop}
          onPointerMove={noop}
          onPointerUp={noop}
          onPointerCancel={noop}
          onTextDraft={noop}
          onTextFinish={noop}
        />,
      ),
    );
  },
};
