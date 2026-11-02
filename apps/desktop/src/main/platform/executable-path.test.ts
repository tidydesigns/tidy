import { expect, test } from "bun:test";
import { delimiter, isAbsolute, join } from "node:path";
import { executablePath } from "./executable-path";

test("CLI paths retain absolute preferences and include user and Homebrew installs", () => {
  const home = join(process.cwd(), "fixture-home");
  const preferred = join(home, "preferred-bin");
  const paths = executablePath(
    [preferred, ".", preferred, "relative/bin"].join(delimiter),
    home,
  ).split(delimiter);
  expect(paths[0]).toBe(preferred);
  expect(paths.filter((path) => path === preferred)).toHaveLength(1);
  expect(paths.every(isAbsolute)).toBe(true);
  expect(paths).toContain(join(home, ".local/bin"));
  if (process.platform !== "win32") {
    expect(paths).toContain("/opt/homebrew/bin");
    expect(paths).toContain("/usr/local/bin");
  }
});
