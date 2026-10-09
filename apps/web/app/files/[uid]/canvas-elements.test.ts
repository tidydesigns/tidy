import { expect, test } from "bun:test";
import { attachCanvasElements, selectionContainsPoint } from "./canvas-elements";

test("selection gap checks read only selected elements once, independent of canvas size", () => {
  const canvas = {} as HTMLElement;
  let reads = 0;
  const element = (left: number, top: number, right: number, bottom: number) =>
    ({
      getBoundingClientRect() {
        reads++;
        return { left, top, right, bottom };
      },
    }) as HTMLElement;
  const registry = new Map<string, HTMLElement>();
  for (let i = 0; i < 10000; i++)
    registry.set(`unrelated-${i}`, {
      getBoundingClientRect() {
        throw new Error("Unselected artwork must not be measured");
      },
    } as unknown as HTMLElement);
  registry.set("a", element(20, 30, 60, 70));
  registry.set("b", element(100, 30, 140, 70));
  attachCanvasElements(canvas, registry);
  expect(selectionContainsPoint(canvas, ["a", "b"], 80, 50)).toBe(true);
  expect(reads).toBe(2);
  expect(selectionContainsPoint(canvas, ["a", "b"], 10, 50)).toBe(false);
  expect(reads).toBe(4);
  expect(selectionContainsPoint(canvas, ["missing"], 80, 50)).toBe(false);
  expect(selectionContainsPoint(null, ["a", "b"], 80, 50)).toBe(false);
  expect(reads).toBe(4);
});
