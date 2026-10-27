import { parseDesignDocument } from "@tidy/design/document";
import type { LocalDesign, Project, Thread } from "../shared/contracts/desktop";

export const demoId = (n: number) => `f0f0f0f0-0000-4000-8000-${String(n).padStart(12, "0")}`;
const timestamp = "2026-10-27T10:00:00.000Z";
export const project: Project = {
  id: demoId(1),
  name: "Form",
  path: "/projects/form",
  openedAt: timestamp,
};
const artwork = demoId(90);
const text = (
  id: string,
  name: string,
  value: string,
  x: number,
  y: number,
  width: number,
  height: number,
  size: number,
  weight = 400,
) => ({
  id,
  parentId: "landing",
  pageId: "page-1",
  type: "text",
  name,
  text: value,
  box: { x, y, width, height },
  style: {
    fontFamily: "Instrument Sans",
    fontSource: "system",
    fontSize: size,
    fontWeight: weight,
    lineHeight: 1.08,
    color: "#292929",
    letterSpacing: -size * 0.035,
  },
});
export function sampleDesign(): LocalDesign {
  return {
    id: demoId(2),
    name: "Form — Landing page",
    path: `.tidy/designs/${demoId(2)}.json`,
    updatedAt: timestamp,
    version: "1",
    nodeCount: 13,
    assets: { [artwork]: "/artwork/cloud-spectrum-1024.webp" },
    document: parseDesignDocument({
      schemaVersion: 1,
      warnings: [],
      pages: [{ id: "page-1", name: "Website" }],
      nodes: [
        {
          id: "landing",
          parentId: null,
          pageId: "page-1",
          type: "artboard",
          name: "Landing / Desktop",
          box: { x: 0, y: 0, width: 960, height: 860 },
          style: { fill: "#fafafa", overflow: "hidden" },
          layout: "absolute",
        },
        text("brand", "Wordmark", "form", 48, 34, 120, 48, 30, 600),
        text("nav-1", "Navigation / Collection", "Collection", 590, 44, 90, 24, 13),
        text("nav-2", "Navigation / About", "About", 714, 44, 60, 24, 13),
        text("nav-3", "Navigation / Get in touch", "Get in touch ↗", 802, 44, 115, 24, 13),
        text("eyebrow", "Eyebrow", "A PLACE FOR GOOD IDEAS", 48, 142, 500, 28, 12, 500),
        text(
          "headline",
          "Hero / Headline",
          "Make room\nfor good ideas.",
          48,
          196,
          820,
          180,
          76,
          500,
        ),
        text(
          "description",
          "Hero / Description",
          "A calmer place to collect, shape and share\nthe things you want to make.",
          52,
          398,
          750,
          58,
          20,
        ),
        {
          id: "cta",
          parentId: "landing",
          pageId: "page-1",
          type: "container",
          name: "Explore the collection",
          box: { x: 52, y: 484, width: 205, height: 48 },
          style: { fill: "#292929", radius: 4 },
          layout: "flex-row",
          align: "center",
          justify: "center",
        },
        {
          id: "cta-label",
          parentId: "cta",
          pageId: "page-1",
          type: "text",
          name: "Button label",
          text: "Explore the collection ↗",
          box: { x: 0, y: 0, width: 184, height: 20 },
          style: {
            fontFamily: "Instrument Sans",
            fontSource: "system",
            fontSize: 14,
            fontWeight: 500,
            color: "#ffffff",
            lineHeight: 1.4,
          },
        },
        {
          id: "cloud-art",
          parentId: "landing",
          pageId: "page-1",
          type: "image",
          name: "Cloud artwork",
          assetId: artwork,
          box: { x: 48, y: 578, width: 864, height: 224 },
          style: { objectFit: "cover", radius: 6 },
        },
        text("footer", "Footer / Copyright", "© Form 2026", 48, 824, 300, 22, 12),
        text(
          "footer-note",
          "Footer / Signoff",
          "A little more room to think.",
          702,
          824,
          210,
          22,
          12,
        ),
      ],
    }),
  };
}
export function sampleThreads(): Thread[] {
  return [
    {
      revision: 1,
      id: demoId(10),
      projectId: project.id,
      title: "Build the landing page",
      harness: "claude",
      status: "completed",
      designIds: [demoId(2)],
      updatedAt: timestamp,
      messages: [
        {
          id: demoId(11),
          role: "user",
          text: "Let’s build Form’s landing page. Give it generous spacing, clear typography and a little colour. Keep the design editable so we can work through the details together.",
        },
        {
          id: demoId(12),
          role: "assistant",
          text: "I’ve put together the first version of the landing page.\n\n- An open, quiet layout with Instrument Sans\n- Editable typography, spacing and colour\n- A cloud artwork panel to give it some character\n\nThe live design is open beside this conversation. Click it to expand the canvas, make a change, then minimise it to come back here.",
        },
      ],
    },
    {
      revision: 1,
      id: demoId(20),
      projectId: project.id,
      title: "Refine the details",
      harness: "codex",
      status: "completed",
      designIds: [demoId(2)],
      updatedAt: "2026-10-27T09:00:00.000Z",
      messages: [
        {
          id: demoId(21),
          role: "user",
          text: "Let’s take a closer look at the type and spacing. Keep the original design file attached.",
        },
        {
          id: demoId(22),
          role: "assistant",
          text: "The same design is attached to this thread. Open the live preview to adjust the headline, move a layer, or explore the canvas tools. The thread and design keep the same context as you switch between them.",
        },
      ],
    },
  ];
}
