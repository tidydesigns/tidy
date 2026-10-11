import { nodeStyle, imageStyle } from "../../lib/design/node-style";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { DesignText } from "@tidy/design-renderer/design-text";
import { TidyDesign } from "@tidy/design-renderer/design";
import type { DesignDocument } from "@bella/design/document";
import type { DesignNode } from "@bella/design/document";
Object.assign(window, {
  nodeStyle,
  imageStyle,
  renderCapture(element: HTMLElement, document: DesignDocument, assets: Record<string, string>) {
    flushSync(() =>
      createRoot(element).render(
        createElement(TidyDesign, { document, rootId: document.nodes[0]!.id, assets }),
      ),
    );
  },
  renderText(element: HTMLElement, node: DesignNode) {
    flushSync(() => createRoot(element).render(createElement(DesignText, { node })));
  },
});
