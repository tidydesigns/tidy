import { expect, test } from "bun:test";
import { z } from "zod";
import { editorErrorMessage } from "./editor-error";

test("validation details do not appear in editor errors, including serialized server issues", () => {
  const result = z
    .object({ deletedSourceKeys: z.array(z.string()).max(1) })
    .safeParse({ deletedSourceKeys: ["one", "two"] });
  if (result.success) throw new Error("Expected validation failure");
  const fallback = "Could not delete the selected layers.";
  expect(editorErrorMessage(result.error, fallback)).toBe(fallback);
  expect(editorErrorMessage(new Error(result.error.message), fallback)).toBe(fallback);
  expect(
    editorErrorMessage(
      Object.assign(new Error("Validation failed"), { name: "ZodError" }),
      fallback,
    ),
  ).toBe(fallback);
  expect(editorErrorMessage(null, fallback)).toBe(fallback);
  expect(editorErrorMessage(new Error(""), fallback)).toBe(fallback);
});

test("useful edit conflict and permission errors retain their messages", () => {
  for (const message of [
    "This layer is locked.",
    "The file changed elsewhere. Retry after reviewing the latest file.",
    "You do not have permission to edit this file.",
  ]) {
    expect(editorErrorMessage(new Error(message), "Could not change layers.")).toBe(message);
  }
});

test("instance structure restrictions explain where to find the recovery control", () => {
  for (const action of [
    "adding or reparenting",
    "deleting or moving",
    "reparenting",
    "reordering",
  ]) {
    const message = editorErrorMessage(
      new Error(`Detach the instance before ${action} its children.`),
      "Could not change layers.",
    );
    expect(message).toContain("component instance");
    expect(message).toContain("Detach instance in the Component section");
  }
});
