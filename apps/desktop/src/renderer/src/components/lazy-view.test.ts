import type {} from "../env";
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { lazyView } from "./lazy-view";

describe("prepared lazy views", () => {
  test("preloading deduplicates work and renders content without a loading fallback", async () => {
    let loads = 0;
    const View = lazyView(
      async () => {
        loads++;
        return { default: ({ text }: { text: string }) => createElement("p", null, text) };
      },
      { label: "sample" },
    );
    await Promise.all([View.preload(), View.preload()]);
    const html = renderToString(createElement(View, { text: "Sample conversation" }));
    expect(loads).toBe(1);
    expect(html).toContain("Sample conversation");
    expect(html).not.toContain("Loading sample");
    expect(html).not.toContain("<template");
  });

  test("failed preparation can be retried", async () => {
    let loads = 0;
    const View = lazyView(
      async () => {
        if (++loads === 1) throw new Error("Temporary chunk failure");
        return { default: () => createElement("p", null, "Recovered") };
      },
      { label: "sample" },
    );
    await expect(View.preload()).rejects.toThrow("Temporary chunk failure");
    await View.preload();
    expect(renderToString(createElement(View))).toContain("Recovered");
    expect(loads).toBe(2);
  });
});
