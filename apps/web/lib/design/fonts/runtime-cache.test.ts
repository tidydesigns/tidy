import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("font stylesheet eviction retains mounted families and reloads evicted faces", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { expect } from "bun:test";
    const elements = new Set(); let fetches = 0;
    globalThis.document = {
      createElement: () => ({ dataset: {}, remove() { elements.delete(this); } }),
      head: { appendChild(element) { elements.add(element); } },
      fonts: { async load() { return [{}]; } },
    };
    globalThis.fetch = async () => { fetches++; return new Response('@font-face {font-family: "test"; src: url(test);}'); };
    const { webFonts } = await import('./lib/design/fonts/catalog');
    const { fontRegistry } = await import('./lib/design/fonts/runtime');
    const fonts = webFonts.slice(0, 80);
    const release = fontRegistry.retainFamilies(fonts.slice(0, 10).map(font => font.family));
    for (const font of fonts) await fontRegistry.load(font.family, 400, false, 'Aa', 'web');
    expect(elements.size).toBe(64);
    for (const font of fonts.slice(0, 10)) expect([...elements].some(element => element.dataset.designFont === font.family)).toBe(true);
    const before = fetches;
    await fontRegistry.load(fonts[10].family, 400, false, 'Aa', 'web');
    expect(fetches).toBe(before + 1); expect(elements.size).toBe(64);
    release();
  `,
    ],
    { cwd: resolve(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe" },
  );
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
});
