import sharp from "sharp";
import type { Locator, Page } from "playwright";
import { required } from "./fixtures";

export async function visibleColourPoint(
  page: Page,
  element: Locator,
  rgb: readonly [number, number, number],
) {
  const bounds = required(await element.boundingBox());
  const { data, info } = await sharp(await page.screenshot())
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const left = Math.max(0, Math.ceil(bounds.x + 2));
  const top = Math.max(0, Math.ceil(bounds.y + 2));
  const right = Math.min(info.width, Math.floor(bounds.x + bounds.width - 2));
  const bottom = Math.min(info.height, Math.floor(bounds.y + bounds.height - 2));
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const offset = (y * info.width + x) * info.channels;
      if (rgb.every((value, index) => data[offset + index] === value))
        return { x: x + 0.5, y: y + 0.5 };
    }
  }
  throw new Error(`No visible rgb(${rgb.join(",")}) pixel inside the source element.`);
}
