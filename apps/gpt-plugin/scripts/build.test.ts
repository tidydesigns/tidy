import { expect, test } from "bun:test";
import { buildPlugin } from "./build";

test("standalone plugin HTML retains full bundled dependency licences", async () => {
  const html = await buildPlugin();
  for (const name of ["Paper.js", "React", "Zod"]) {
    const license = await Bun.file(
      new URL(`../../../licenses/bundled/${name}.txt`, import.meta.url),
    ).text();
    expect(html).toContain(license.trim());
  }
  expect(html).toContain("react-dom@");
  expect(html).toContain("scheduler@");
  expect(html.match(/<\/script>/g)).toHaveLength(1);
});
