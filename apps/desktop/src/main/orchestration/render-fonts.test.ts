import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { designNodeSchema } from "@tidy/design/document";
import { canvasFonts } from "./render-fonts";

afterEach(() => mock.restore());
const label = (family: string, weight = 400) =>
  designNodeSchema.parse({
    id: `text-${weight}`,
    name: "Label",
    parentId: null,
    type: "text",
    text: "Wiśniewska-Kowalczyk",
    box: { x: 0, y: 0, width: 200, height: 24 },
    style: { fontFamily: family, fontWeight: weight },
  });

test("bundled typography embeds one shared variable face without fetching or including hidden text fonts", async () => {
  const fetch = spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected network request"),
  );
  const hidden = designNodeSchema.parse({
    id: "hidden",
    parentId: null,
    type: "container",
    name: "Hidden",
    visible: false,
    box: { x: 0, y: 0, width: 100, height: 100 },
  });
  const privateText = {
    ...label("Private font"),
    id: "private",
    parentId: hidden.id,
    style: { fontFamily: "Private font", fontSource: "local" as const },
  };
  const fonts = await canvasFonts(
    [
      ...[400, 500, 600, 700].map((weight) => label("Instrument Sans", weight)),
      hidden,
      privateText,
      { ...hidden, id: "transparent", visible: true, style: { opacity: 0 } },
      { ...privateText, id: "transparent-child", parentId: "transparent" },
      {
        ...privateText,
        id: "transparent-text",
        parentId: null,
        style: { ...privateText.style, opacity: 0 },
      },
    ],
    new AbortController().signal,
  );
  expect(fonts.diagnostics).toEqual([]);
  expect(fonts.css.match(/@font-face/g)).toHaveLength(1);
  expect(fonts.css).toContain("data:font/woff2;base64,");
  expect(fonts.requests).toHaveLength(4);
  expect(fetch).not.toHaveBeenCalled();
});

test("large font resources evict older cached bytes before subsequent previews", async () => {
  const fontReads = new Map<string, number>();
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = new URL(String(input));
        if (url.hostname === "fonts.googleapis.com") {
          const name = url.searchParams.get("family")?.startsWith("Lato") ? "lato" : "inter";
          return new Response(
            `@font-face{font-weight:400;font-style:normal;src:url(https://fonts.gstatic.com/cache-budget-${name}.woff2);}`,
          );
        }
        fontReads.set(url.pathname, (fontReads.get(url.pathname) ?? 0) + 1);
        return new Response(new Uint8Array(4 * 1024 * 1024));
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  for (const family of ["Lato", "Inter", "Lato"])
    expect((await canvasFonts([label(family)], new AbortController().signal)).diagnostics).toEqual(
      [],
    );
  expect(fontReads.get("/cache-budget-lato.woff2")).toBe(2);
  expect(fontReads.get("/cache-budget-inter.woff2")).toBe(1);
});

test("font resolution cannot follow a stylesheet to a host outside the allowlist", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      "@font-face{font-family:Roboto;font-weight:400;font-style:normal;src:url(https://outside.invalid/font.woff2);}",
    ),
  );
  const fonts = await canvasFonts([label("Roboto")], new AbortController().signal);
  expect(fonts.css).toBe("");
  expect(fonts.diagnostics[0].kind).toBe("missing_font");
  expect(fonts.diagnostics[0].message).toBe("Unsupported font resource URL.");
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0][0])).toStartWith("https://fonts.googleapis.com/");
  expect(fetch.mock.calls[0][1]?.redirect).toBe("error");
});
