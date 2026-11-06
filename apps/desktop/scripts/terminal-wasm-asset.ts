/** ghostty-web 0.4 ships an inline WASM copy even when callers supply a runtime. */
export function terminalWasmAsset(code: string, id: string) {
  if (!/[/\\]ghostty-web[/\\]dist[/\\]ghostty-web\.js$/.test(id)) return;
  const embedded = /"data:application\/wasm;base64,[A-Za-z0-9+/=]+"/g;
  if ([...code.matchAll(embedded)].length !== 1)
    throw new Error("Review the Ghostty WASM asset transform for this package version.");
  return {
    code:
      'import __tidyGhosttyWasmURL from "ghostty-web/ghostty-vt.wasm?url";\n' +
      code.replace(embedded, "__tidyGhosttyWasmURL"),
    map: null,
  };
}
