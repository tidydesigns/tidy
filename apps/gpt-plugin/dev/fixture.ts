import { blankDesignDocument, designNodeSchema } from "@bella/design/document";
import type { DesignPreview } from "../src/contract";

const frame = (id: string, name: string) =>
  designNodeSchema.parse({
    id,
    name,
    type: "artboard",
    parentId: null,
    box: { x: 0, y: 0, width: 360, height: 280 },
    layout: "flex-column",
    gap: 16,
    padding: 24,
    align: "stretch",
    justify: "start",
    style: { fill: "#ffffff", radius: 12 },
  });
const text = (id: string, parentId: string, value: string, size: number) =>
  designNodeSchema.parse({
    id,
    name: "Heading",
    type: "text",
    parentId,
    box: { x: 0, y: 0, width: 312, height: 36 },
    widthMode: "fill",
    heightMode: "hug",
    text: value,
    style: { fontFamily: "system-ui", fontSize: size, fontWeight: 500, color: "#282a28" },
  });
export const fixture: DesignPreview = {
  fileId: "local-preview",
  name: "Onboarding",
  url: "https://app.tidydesign.co/files/local-preview",
  revision: 1,
  roots: [
    { id: "welcome", name: "Welcome", pageId: "page-1", width: 360, height: 280 },
    { id: "profile", name: "Profile", pageId: "page-1", width: 360, height: 280 },
  ],
  selectedRootId: "welcome",
  assets: {},
  fontUrls: [],
  document: {
    ...blankDesignDocument(),
    nodes: [
      frame("welcome", "Welcome"),
      text("title", "welcome", "Make room for your ideas", 28),
      text("copy", "welcome", "A shared space to shape something new.", 16),
      frame("profile", "Profile"),
      text("profile-title", "profile", "Your workspace", 28),
      text("profile-copy", "profile", "Bring your team together.", 16),
    ],
  },
};
