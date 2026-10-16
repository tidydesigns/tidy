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

test("font exports group glyph requests and reuse embedded public font bytes", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { expect } from "bun:test";
    let fontReads = 0; const samples = [];
    globalThis.document = {
      createElement: () => ({ dataset: {}, remove() {} }),
      head: { appendChild() {} },
      fonts: { async load(_face, text) { samples.push(text); return [{}]; } },
    };
    globalThis.FileReader = class {
      readAsDataURL(blob) {
        blob.arrayBuffer().then(bytes => {
          this.result = 'data:font/woff2;base64,' + Buffer.from(bytes).toString('base64');
          this.onload();
        });
      }
    };
    globalThis.fetch = async url => {
      if (String(url).startsWith('https://fonts.gstatic.com/')) {
        fontReads++; return new Response(new Uint8Array([1, 2, 3]));
      }
      return new Response('@font-face{font-family:"test";font-weight:400;font-style:normal;src:url(https://fonts.gstatic.com/f.woff2);unicode-range:U+0000-00FF;}');
    };
    const { webFonts } = await import('./lib/design/fonts/catalog');
    const { fontRegistry } = await import('./lib/design/fonts/runtime');
    const family = webFonts[0].family;
    const requests = ['A', 'Z', 'A'].map(text => ({ family, weight: 400, italic: false, text, source: 'web' }));
    const first = await fontRegistry.exportCss(requests);
    const second = await fontRegistry.exportCss(requests);
    expect(samples).toEqual(['AZ']);
    expect(fontReads).toBe(1);
    expect(first).toContain('data:font/woff2;base64,AQID');
    expect(second).toBe(first);
  `,
    ],
    { cwd: resolve(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe" },
  );
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
});
