import { nodeStyle, imageStyle } from "../../lib/design/node-style";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { DesignText } from "@tidy/design-renderer/design-text";
import type { DesignNode } from "@bella/design/document";
Object.assign(window, {
  nodeStyle,
  imageStyle,
  renderText(element: HTMLElement, node: DesignNode) {
    flushSync(() => createRoot(element).render(createElement(DesignText, { node })));
  },
});
