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
    date: "2026-10-24",
    features: [
      {
        title: "Live canvas windows in desktop threads",
        details:
          "Open design previews as live canvas windows above your conversation. Move, resize or dismiss each window, and manage open designs from the compact composer dock.",
      },
      {
        title: "Choose models and project context",
        details:
          "Search models, mark favourites and choose your project branch from the desktop composer. Model, permission and context controls are grouped beside your message.",
      },
    ],
    fixes: [
      {
        title: "Paste where you need it",
        details:
          "Pasting respects the selected frame and canvas context. Use Paste here from the context menu to place copied layers at a specific canvas position.",
      },
      {
        title: "Return to your desktop workspace",
        details:
          "Refreshing the desktop app restores your workspace, view, file and thread instead of resetting your navigation.",
      },
      {
        title: "Consistent file lists",
        details:
          "Web and desktop file lists now show creator profile pictures and consistent file details. Relative dates stay up to date while you browse.",
      },
      {
        title: "Faster cloud file opening",
        details:
          "Cloud designs open with less waiting, and interrupted previews recover more reliably.",
      },
      {
        title: "Clearer desktop sign-in",
        details:
          "Desktop cloud sync and agent connections now show distinct sign-in requests, making it clearer what you are authorising.",
      },
    ],
  },
  {
    date: "2026-10-23",
    features: [
      {
        title: "Cloud workspaces in the desktop app",
        details:
          "Sign in from Settings to browse and edit your cloud workspace files. Downloaded designs reopen locally, edits sync in the background, and sync status helps you resolve conflicting changes while keeping both versions.",
      },
      {
        title: "Magnified canvas colour sampling",
        details:
          "Use the colour picker to sample a painted canvas colour with a magnified preview for more precise selection.",
      },
    ],
    fixes: [
      {
        title: "Smoother trackpad navigation",
        details:
          "Panning and zooming avoid unnecessary hover updates, and canvas navigation keeps working when your pointer is over an artboard title.",
      },
      {
        title: "Clearer vectorisation failures",
        details:
          "If an image cannot be vectorised, a message explains what went wrong, including when there are no visible pixels to trace.",
      },
      {
        title: "Immersive fullscreen designs",
        details:
          "Desktop design files use the full window in fullscreen, without unused titlebar space.",
      },
      {
        title: "Clearer desktop activity states",
        details:
          "Tool activity uses distinct status colours, including amber for interrupted work. Dark theme surfaces and composer controls are easier to distinguish.",
      },
    ],
  },
  {
    date: "2026-10-22",
    features: [
      {
        title: "Queue agent follow-ups",
        details:
          "Write follow-up messages while your desktop agent is working. Queue them for later or send instructions immediately, with queued messages preserved if delivery fails.",
      },
      {
        title: "Choose skills from the composer",
        details: "Type / in the desktop composer to browse and select available project skills.",
      },
      {
        title: "Update your coding agents",
        details:
          "The desktop app checks for updates to supported coding agents and lets you install them when no runs or queued follow-ups are active.",
      },
      {
        title: "Reorder threads and check remaining usage",
        details:
          "Drag desktop thread cards to reorder them and see your remaining usage as a percentage.",
      },
      {
        title: "Undo resolved comments",
        details:
          "Resolve a comment thread and use Undo to bring it back. Posting feedback appears immediately while your comment is being sent.",
      },
      {
        title: "Toggle the desktop sidebar",
        details: "Show or hide the sidebar from the integrated macOS window header.",
      },
    ],
    fixes: [
      {
        title: "More accurate image vectorisation",
        details:
          "Vectorised images preserve fine details more accurately with fewer unnecessary layers and less processing.",
      },
      {
        title: "Smoother desktop conversations",
        details:
          "Streaming responses keep the interface more responsive, and conversation previews stay open while you hover over them. The message composer grows before it starts scrolling.",
      },
    ],
  },
  {
    date: "2026-10-21",
    features: [
      {
        title: "Automatic desktop updates",
        details:
          "Supported macOS builds check for app updates automatically. Use the sidebar update control to see progress and restart when an update is ready.",
      },
      {
        title: "Simpler colour editing",
        details:
          "Edit colours in a picker beside the inspector and sample colours directly from the canvas. Selection properties are easier to scan.",
      },
    ],
    fixes: [
      {
        title: "Smoother layer dragging",
        details:
          "Moving layers across the canvas responds more smoothly, especially in larger designs.",
      },
      {
        title: "Instant privacy choices",
        details:
          "Privacy controls respond immediately and group browser analytics and agent diagnostics choices together.",
      },
      {
        title: "Keep the page still behind dialogs",
        details: "Opening a modal prevents the page behind it from scrolling.",
      },
      {
        title: "Clearer error notifications",
        details:
          "Failed actions show consistent, dismissible notices, with clearer feedback when you need to retry or sign in again.",
      },
      {
        title: "Steadier editor controls",
        details:
          "Toolbar loading placeholders match the finished controls, and corner-radius tooltips stay visible above selection handles.",
      },
    ],
  },
  {
    date: "2026-10-20",
    fixes: [
      {
        title: "Keep quick drag positions",
        details:
          "Layers stay where you release them, including during fast drags and when opening or closing the inspector.",
      },
      {
        title: "Steadier alignment guides",
        details: "Alignment guides stay in place while you move layers.",
      },
      {
        title: "Smoother canvas navigation",
        details: "Panning and zooming respond faster while frames are selected.",
      },
      {
        title: "Faster agent previews and imports",
        details: "Connected agents take less time to generate previews and import designs.",
      },
    ],
  },
  {
    date: "2026-10-19",
    features: [
      {
        title: "Local desktop workspaces",
        details:
          "Open local projects and edit designs in the desktop app. Work alongside Codex or Claude Code conversations, with file and image attachments.",
      },
      {
        title: "Easier desktop navigation",
        details:
          "Switch projects, browse files and revisit conversations. Expand tool activity to see what your agent did.",
      },
      {
        title: "Improved design tokens",
        details:
          "Browse and search tokens, edit them in a floating panel, and pick colors from canvas layers. Connected agents can also create tokens and apply them to layers.",
      },
      {
        title: "Select layers within groups",
        details:
          "Select layers within groups more predictably. Hover outlines show which layer you will select.",
      },
      {
        title: "Select artboards by title",
        details: "Click an artboard's canvas title to select it and its matching layer.",
      },
    ],
    fixes: [
      {
        title: "More reliable text editing",
        details:
          "Pressing Escape to finish editing keeps your text changes. Text formatting controls also behave more consistently.",
      },
      {
        title: "Responsive comments and reactions",
        details:
          "Comments appear immediately and threads stay open while you post. Reactions stay visible when comments refresh.",
      },
      {
        title: "Prevent accidental trackpad navigation",
        details:
          "Horizontal canvas gestures no longer take you back or forward through your browser history.",
      },
      {
        title: "Faster onboarding",
        details: "Spend less time waiting when creating an organization and connecting your agent.",
      },
      {
        title: "More reliable account navigation",
        details:
          "Signing in, switching organizations and accepting invitations now take you to the right page when your session changes.",
      },
      {
        title: "Keep canvas controls accessible",
        details:
          "Canvas controls stay above selected layers. Desktop thread controls no longer overlap the view controls.",
      },
      {
        title: "Faster canvas interactions",
        details: "Selecting layers and showing hover outlines take less processing.",
      },
    ],
  },
  {
    date: "2026-10-18",
    fixes: [
      {
        title: "Better keyboard and screen reader access",
        details:
          "Improved keyboard navigation, focus handling and control labels across the editor, workspace, prototypes and capture extension.",
      },
      {
        title: "Clearer canvas modes and toolbar placement",
        details:
          "Design and Inspect modes are easier to distinguish. Mobile uses a compact toolbar, and desktop toolbar placement respects your preference.",
      },
    ],
  },
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
