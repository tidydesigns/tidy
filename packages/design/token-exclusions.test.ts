import { expect, test } from "bun:test";
import { bindingPath, tokenBindingExclusions, typographyProperties } from "./design-tokens";
import { bindingKinds, type TokenBinding } from "./token-bindings";

test("indexed exclusions preserve every binding, ancestor, duplicate and declaration order", () => {
  const groups = (Object.keys(bindingKinds) as TokenBinding[]).map((binding) => [
    `tokenBindings.${binding}`,
    ...(binding === "textStyle"
      ? typographyProperties.map((key) => `style.${key}`)
      : [bindingPath(binding)]),
  ]);
  // Declarative compatibility oracle: an original path excludes its descendants.
  const reference = (paths: string[]) => [
    ...paths,
    ...groups
      .filter((group) =>
        group.some((property) =>
          paths.some((path) => property === path || property.startsWith(`${path}.`)),
        ),
      )
      .flat(),
  ];
  const paths = [
    "style",
    "box",
    "tokenBindings",
    "style.font",
    "style.fontSize.extra",
    "unknown",
    "",
    ...new Set(groups.flat()),
  ];
  for (const path of paths)
    for (const input of [[path], [path, path], [path, "style.fontSize", "tokenBindings.width"]])
      expect(tokenBindingExclusions(input)).toEqual(reference(input));
  expect(tokenBindingExclusions([])).toEqual([]);
});
