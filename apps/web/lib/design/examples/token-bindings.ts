import { blankDesignDocument, buildDrawnNode, parseDesignDocument } from "../document";
export function buildTokenDocument() {
  return parseDesignDocument({
    ...blankDesignDocument(),
    designTokens: {
      rounded: { type: "radius", value: 12 },
      corner: { type: "radius", alias: "rounded" },
      inset: { type: "spacing", value: 16 },
      card: { type: "dimension", value: 280 },
      body: {
        type: "typography",
        value: {
          fontFamily: "system-ui",
          fontSource: "system",
          fontSize: 18,
          fontWeight: 500,
          lineHeight: 1.4,
          lineHeightMode: "percent",
        },
      },
    },
    nodes: [
      {
        ...buildDrawnNode("token-frame", "artboard", null, {
          x: 20,
          y: 20,
          width: 500,
          height: 400,
        }),
        name: "Tokens frame",
        layout: "flex-column",
        tokenBindings: { gap: "inset", padding: "inset" },
      },
      {
        ...buildDrawnNode("token-card", "container", "token-frame", {
          x: 0,
          y: 0,
          width: 100,
          height: 60,
        }),
        name: "Card",
        tokenBindings: { width: "card", radius: "corner" },
        style: { fill: "#123456" },
      },
      {
        ...buildDrawnNode("token-label", "text", "token-frame", {
          x: 0,
          y: 0,
          width: 260,
          height: 40,
        }),
        name: "Label",
        text: "Bound text",
        tokenBindings: { textStyle: "body" },
      },
      {
        ...buildDrawnNode("token-second", "container", "token-frame", {
          x: 0,
          y: 0,
          width: 100,
          height: 60,
        }),
        name: "Second card",
        style: { fill: "#123456" },
      },
    ],
  });
}
