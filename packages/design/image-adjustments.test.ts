import { expect, test } from "bun:test";
import { imageAdjustmentsSchema } from "./document";
import { imageAdjustmentFilter } from "./image-adjustments";

test("filter IDs cannot break out of their XML attribute in neutral or adjusted markup", () => {
  const id = `image\"><script>alert('fixture')</script><filter id="&quot;`;
  const escaped =
    "image&quot;&gt;&lt;script&gt;alert(&apos;fixture&apos;)&lt;/script&gt;&lt;filter id=&quot;&amp;quot;";
  for (const adjustments of [{}, { exposure: 0.5, highlights: -0.2 }]) {
    const markup = imageAdjustmentFilter(id, adjustments);
    expect(markup.startsWith(`<filter id="${escaped}"`)).toBe(true);
    expect(markup).not.toContain("<script>");
    expect(markup.match(/<filter\b/g)).toHaveLength(1);
  }
  expect(imageAdjustmentFilter("image-r_1-2", {})).toBe(
    '<filter id="image-r_1-2"><feComponentTransfer/></filter>',
  );
});

test("image adjustments reject non-finite, out-of-range and non-numeric document input", () => {
  for (const exposure of [NaN, Infinity, -Infinity, -1.01, 1.01, '"/><script/>'])
    expect(imageAdjustmentsSchema.safeParse({ exposure }).success).toBe(false);
  expect(imageAdjustmentsSchema.safeParse({ exposure: 1, shadows: -1 }).success).toBe(true);
  expect(imageAdjustmentsSchema.safeParse({ unexpected: 1 }).success).toBe(false);
});
