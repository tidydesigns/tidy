import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageBar } from "./usage-bar";

test("unlimited allowances show numeric usage without a false progress maximum", () => {
  const html = renderToStaticMarkup(
    <dl>
      <UsageBar label="Files" used={42} limit={null} />
    </dl>,
  );
  expect(html).toContain("42 / Unlimited");
  expect(html).toContain("Unlimited remaining");
  expect(html).not.toContain('role="progressbar"');
  expect(html).not.toContain("aria-valuemax");
});

test("zero and exhausted allowances remain bounded and show zero remaining", () => {
  for (const limit of [0, 5000]) {
    const html = renderToStaticMarkup(
      <dl>
        <UsageBar label="MCP calls" used={limit} limit={limit} />
      </dl>,
    );
    expect(html).toContain("0 remaining");
    expect(html).toContain("width:100%");
    expect(html).not.toContain("NaN");
  }
});
