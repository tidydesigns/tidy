# Public Figma compatibility fixtures

These small files are derived from public, real Figma Design exports and clipboard
captures, not from customer files or the operator's private Design System.fig.

- `circle.fig`: OpenFig-org/openfig-core, `test-fixtures/circle.fig` (MIT).
- `line.fig`: OpenFig-org/openfig-core,
  `test-fixtures/vector-network/straight-2-point-line.fig` (MIT).
- `vector.fig`: OpenFig-org/openfig-core, `test-fixtures/OpenFigs.fig` (MIT).
- `component.clipboard.html`: a synthetic Badge master/instance/override scenario
  re-encoded with the public `circle.fig` schema and geometry. The master lives
  on the hidden library canvas to exercise dependency import.
- `group.clipboard.html`: gridaco/grida,
  `fixtures/test-fig/clipboard/group-with-r-g-b-rect.clipboard.html` (Apache-2.0).

Sources:
https://github.com/OpenFig-org/openfig-core
https://github.com/gridaco/grida

Edit history, user IDs, file keys, paste IDs, descriptions and archive metadata were
removed before re-encoding the documents. Layer geometry and colours are retained.
Clipboard tests replay native Figma HTML payloads through the browser clipboard.
These fixtures establish specific import behaviour, not full Figma compatibility.
