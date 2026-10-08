import { expect, test } from "bun:test";
import { blankDesignDocument, designNodeSchema } from "./document";
import { diagnoseLayout } from "./layout-diagnostics";

const node = (id: string, parentId: string | null, changes: object = {}) =>
  designNodeSchema.parse({
    id,
    parentId,
    name: id,
    type: "container",
    box: { x: 0, y: 0, width: 100, height: 40 },
    ...changes,
  });
const codes = (nodes: ReturnType<typeof node>[]) =>
  diagnoseLayout({ ...blankDesignDocument(), nodes }).map((issue) => issue.code);

test("checks flex overflow including independent padding, borders and gap", () => {
  const row = node("row", null, {
    layout: "flex-row",
    align: "center",
    justify: "center",
    paddingLeft: 10,
    paddingRight: 20,
    style: { borderWidth: 2 },
    gap: 8,
  });
  expect(
    codes([
      row,
      node("one", "row", { box: { x: 0, y: 0, width: 40, height: 20 } }),
      node("two", "row", { box: { x: 0, y: 0, width: 30, height: 20 } }),
    ]),
  ).toContain("flow-overflow");
  expect(codes([{ ...row, wrap: true }, node("one", "row"), node("two", "row")])).not.toContain(
    "flow-overflow",
  );
});
test("rejects unresolved fill/hug cycles and ignores absolute decorations", () => {
  const row = node("row", null, {
    layout: "flex-row",
    align: "center",
    justify: "center",
    widthMode: "hug",
  });
  const child = node("one", "row", { widthMode: "fill" });
  expect(codes([row, child])).toContain("cyclic-width-sizing");
  expect(codes([row, { ...child, positionMode: "absolute" }])).not.toContain("cyclic-width-sizing");
});
test("reports ignored coordinates without guessing visual fidelity", () => {
  const row = node("row", null, {
    layout: "flex-row",
    align: "center",
    justify: "center",
    widthMode: "hug",
  });
  expect(
    codes([row, node("label", "row", { box: { x: 20, y: 10, width: 80, height: 20 } })]),
  ).toEqual(["ignored-flow-coordinates"]);
});
test("checks accessible names and nested controls even in absolute decoration groups", () => {
  const button = node("button", null, {
    layout: "flex-row",
    align: "center",
    justify: "center",
    semantics: { element: "button", label: "Create" },
  });
  const child = node("child", "button", {
    positionMode: "absolute",
    semantics: { element: "button", label: "Other" },
  });
  expect(codes([button, child])).toContain("nested-control");
  expect(
    codes([
      button,
      node("absolute-label", "button", { type: "text", text: "Create", positionMode: "absolute" }),
    ]),
  ).toContain("absolute-control-content");
  expect(
    codes([
      { ...button, semantics: { element: "button" } },
      node("label", "button", {
        type: "text",
        text: "+",
        semantics: { element: "span", hidden: true },
      }),
    ]),
  ).toContain("missing-accessible-name");
});
