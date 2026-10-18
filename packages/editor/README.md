# Shared Tidy editor

Web and desktop use the same `FileEditor` component, canvas gestures, history,
layers, tokens, inspectors, components, vector tools, fonts and exports. The theme
and editor chrome CSS are shared too. This package contains browser-safe code;
Next.js, database access, authentication and native filesystem APIs stay in apps.

`apps/web/app/files/[uid]/file-editor.tsx` supplies hosted navigation, image and
thumbnail components, telemetry and the rename server action through
`EditorHostProvider`. Existing web imports re-export the extracted modules so
server services, renderers and regression tests continue using the same operations.

Desktop enables `local` mode and supplies `localPersistence`: each committed edit
awaits an atomic native write before the history queue acknowledges it. Image
placement and file names use the same adapter. `externalDocument` accepts agent
changes without remounting the canvas. `active` suspends global keyboard and
clipboard handlers while another desktop workspace is focused. Hosted comments,
reviews and room connections remain optional capabilities of the web host.

Consumers import `theme.css` and `chrome.css` after Tailwind and add this package's
`src` directory as a Tailwind source. Instrument fonts and Tidy branding live in
`@tidy/ui`; document schemas and rendering remain in `@tidy/design` and
`@tidy/design-renderer`.
