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
    date: "2026-10-17",
    features: [
      {
        title: "Connect your agent with a prompt",
        details:
          "Copy a setup prompt into your coding agent to connect it to Tidy, with guided sign-in and connection checks. Agent setup is now available during onboarding too.",
      },
      {
        title: "Workspace navigation on smaller screens",
        details:
          "Access workspace navigation from a collapsible menu on smaller screens, with keyboard controls and screen reader support.",
      },
    ],
    fixes: [
      {
        title: "Finish onboarding when your agent connects",
        details:
          "Onboarding now detects when your agent connects and lets you continue into your workspace.",
      },
      {
        title: "Clearer component instance editing",
        details:
          "Linked instances now explain which edits require detaching. Detach directly from the canvas context menu or from the notification when an edit is blocked.",
      },
      {
        title: "Dismiss editor notifications",
        details:
          "Editor alerts now appear together in the bottom-right corner and can be dismissed.",
      },
    ],
  },
  {
    date: "2026-10-16",
    features: [
      {
        title: "Turn images into editable vectors",
        details:
          "Vectorise raster images into editable canvas shapes and paths, with support for gradients and fine details.",
      },
    ],
    fixes: [
      {
        title: "Start new files faster",
        details:
          "Creating a file opens the editor immediately, with less waiting for the document to load.",
      },
      {
        title: "Faster file previews",
        details:
          "File previews prioritise thumbnails visible on screen and reuse existing previews, reducing loading and rendering work.",
      },
      {
        title: "Faster selection exports",
        details:
          "Exporting selected layers takes less preparation time, especially in large documents.",
      },
      {
        title: "Quicker Settings and agent setup",
        details:
          "Settings and MCP setup show their main content while secondary details load. Navigation also recovers more reliably from failed page preloads.",
      },
      {
        title: "Keep features available with analytics turned off",
        details: "Optional product features no longer depend on accepting analytics cookies.",
      },
    ],
  },
  {
    date: "2026-10-15",
    fixes: [
      {
        title: "Sharper exports",
        details:
          "Exports now default to 2× resolution, with smoother text and vector edges in PNG, WebP and PDF output.",
      },
      {
        title: "Faster Figma imports",
        details:
          "Figma component instances expand faster, and layout checks take less time in large documents.",
      },
      {
        title: "Protect pending canvas edits",
        details: "Navigation guards help prevent leaving a file before your edits finish syncing.",
      },
      {
        title: "Preserve edits during agent reimports",
        details:
          "Fixed cases where agent reimports could overwrite browser edits. Import conflicts now give agents clearer instructions for keeping your changes, using the import or creating a duplicate.",
      },
      {
        title: "Keep invitation drafts",
        details:
          "Email addresses typed while team invitations are sending are no longer cleared when the request completes.",
      },
      {
        title: "Feedback notifications in the bottom-right",
        details: "Feedback confirmation toasts now appear in the bottom-right corner.",
      },
    ],
  },
  {
    date: "2026-10-14",
    features: [
      {
        title: "Import from Figma",
        details:
          "Import .fig files or paste copied Figma layers as editable designs, preserving masks, text formatting and layout.",
      },
    ],
    fixes: [
      {
        title: "More reliable image loading and exports",
        details:
          "Asset previews compete less with canvas images for loading capacity, and large exports use less memory.",
      },
      {
        title: "OpenCode compatibility",
        details: "Fixed agent authorization so OpenCode can request editing access.",
      },
      {
        title: "More reliable sign-in",
        details: "Fixed an issue that could cause authentication requests to stall.",
      },
      {
        title: "Clearer account deletion",
        details:
          "Account deletion now explains organization ownership blockers and provides access to account options after leaving your last organization.",
      },
    ],
  },
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
    ],
  },
  {
    date: "2026-10-12",
    fixes: [
      {
        title: "More accurate website imports",
        details:
          "Website captures better preserve public content, photos, icons, borders and clipped elements, while keeping private fields redacted.",
      },
      {
        title: "Delete and undo large website imports",
        details:
          "Large website captures can now be deleted and restored with undo, including older imports that previously became undeletable.",
      },
      {
        title: "More reliable image loading",
        details:
          "Documents with many images now pace loading requests to avoid capacity failures and unnecessary retries. Multi-selection exports reuse repeated image downloads while preserving original quality.",
      },
    ],
  },
  {
    date: "2026-10-11",
    features: [
      {
        title: "See where agents are working",
        details:
          "Connected agents now appear as teammate cursors with subtle outlines on the layers they are working on. Activity without a visible target appears in the canvas margin, with details available on demand.",
      },
      {
        title: "Batch edits from agents",
        details:
          "Agents can now group multiple layer edits into a single operation, reducing the calls needed to update a design.",
      },
    ],
    fixes: [
      {
        title: "Faster agent calls",
        details:
          "Connected agents discover tools, read documents and edit multiple layers with less repeated processing and fewer database round trips.",
      },
      {
        title: "Delete selected layers consistently",
        details:
          "Keyboard and context-menu deletion now act on the full selection while respecting locked layers. Right-clicking within a selected frame or between selected frames preserves your selection.",
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
