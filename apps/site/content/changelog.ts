export type ChangelogItem = {
  title: string;
  details: string;
};

export type ChangelogEntry = {
  date: string;
  features?: readonly ChangelogItem[];
  fixes?: readonly ChangelogItem[];
};

// Add one entry per day using YYYY-MM-DD dates. Entries display newest first.
// Omit a category when there are no updates; every bullet has expandable details.
export const changelog: readonly ChangelogEntry[] = [
  {
    date: "2026-10-13",
    features: [
      {
        title: "Download your data or delete your account",
        details:
          "Export your personal data as JSON or delete your account from Profile settings. Verify your identity using your linked password, Google or GitHub account.",
      },
      {
        title: "Simpler agent setup",
        details:
          "Connect your coding agent in three steps, with instructions for each supported client and connection help when needed.",
      },
    ],
    fixes: [
      {
        title: "Faster editing in large documents",
        details:
          "Layer editing, bulk selection and drag previews are faster in documents with thousands of layers.",
      },
      {
        title: "Lower memory use for images",
        details:
          "The canvas now loads image resolutions suited to your viewport and shares decoded images, while preserving original uploads and exports.",
      },
      {
        title: "Steadier folder navigation",
        details: "Controls and file cards now stay in place when moving between folders and Files.",
      },
      {
        title: "Analytics collection paused",
        details:
          "Product analytics, session replay and analytics-based error reporting are paused. Vault is temporarily unavailable; existing records are preserved.",
      },
    ],
  },
  {
    date: "2026-10-10",
    fixes: [
      {
        title: "No more flashes when switching editor panels",
        details:
          "Editor panels now stay visually consistent as they open and close, including the version history panel.",
      },
    ],
  },
  {
    date: "2026-10-09",
    features: [
      {
        title: "Tidy is now open source",
        details:
          "The product canvas, collaboration tools, webpage capture extension, and MCP server are available under the Apache License 2.0. You can self-host Tidy and extend it with your own tools.",
      },
    ],
    fixes: [
      {
        title: "Drag selected layers together",
        details:
          "Dragging a layer in a multi-selection now preserves the selection and moves the selected layers together.",
      },
      {
        title: "Smoother editor panel transitions",
        details:
          "Editor panels now open and close smoothly, keeping the canvas movement in step with the panels.",
      },
      {
        title: "Smaller logo fonts",
        details:
          "The app's logo fonts now use compressed WOFF2 files, reducing the amount of font data downloaded.",
      },
    ],
  },
];
