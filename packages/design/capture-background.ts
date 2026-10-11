// Paint an image background in CSS coordinates. Inline backgrounds are sliced
// across line boxes; a trailing link icon belongs at the end of the final slice.
export function drawCaptureBackground(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  imageWidth: number,
  imageHeight: number,
  css: CSSStyleDeclaration,
  bounds: DOMRect,
  fragments: DOMRect[],
) {
  const inline = css.display === "inline" && fragments.length > 1;
  const boxes = inline ? fragments : [bounds];
  const sliced = inline && css.getPropertyValue("box-decoration-break") !== "clone";
  const length = (value: string, total: number) => {
    if (/^-?[\d.]+%$/.test(value)) return (parseFloat(value) * total) / 100;
    if (/^-?[\d.]+px$/.test(value) || value === "0") return parseFloat(value);
    throw new Error("Background position needs a screenshot.");
  };
  let offset = 0;
  let draws = 0;
  for (const box of boxes) {
    let left = 0,
      top = 0,
      width = sliced ? boxes.reduce((sum, box) => sum + box.width, 0) : box.width;
    let height = box.height;
    if (!inline && css.backgroundOrigin !== "border-box") {
      left = parseFloat(css.borderLeftWidth) || 0;
      top = parseFloat(css.borderTopWidth) || 0;
      width -= left + (parseFloat(css.borderRightWidth) || 0);
      height -= top + (parseFloat(css.borderBottomWidth) || 0);
      if (css.backgroundOrigin === "content-box") {
        const px = parseFloat(css.paddingLeft) || 0,
          py = parseFloat(css.paddingTop) || 0;
        left += px;
        top += py;
        width -= px + (parseFloat(css.paddingRight) || 0);
        height -= py + (parseFloat(css.paddingBottom) || 0);
      }
    }
    if (width <= 0 || height <= 0 || !imageWidth || !imageHeight) continue;
    let w = imageWidth,
      h = imageHeight;
    if (["cover", "contain"].includes(css.backgroundSize)) {
      const scale =
        css.backgroundSize === "cover"
          ? Math.max(width / w, height / h)
          : Math.min(width / w, height / h);
      w *= scale;
      h *= scale;
    } else {
      const [x = "auto", y = "auto"] = css.backgroundSize.split(/\s+/);
      if (x !== "auto") w = length(x, width);
      if (y !== "auto") h = length(y, height);
      if (x === "auto" && y !== "auto") w = (h * imageWidth) / imageHeight;
      if (y === "auto" && x !== "auto") h = (w * imageHeight) / imageWidth;
    }
    if (w <= 0 || h <= 0) continue;
    const position = css.backgroundPosition.split(/\s+/);
    if (position.length !== 2) throw new Error("Background position needs a screenshot.");
    const x = length(position[0]!, width - w),
      y = length(position[1]!, height - h);
    const repeat = css.backgroundRepeat;
    if (!/^(repeat|no-repeat)( (repeat|no-repeat))?$|^repeat-[xy]$/.test(repeat))
      throw new Error("Background repetition needs a screenshot.");
    const [rx, ry = rx] = repeat.split(" ");
    const repeatX = rx === "repeat" || rx === "repeat-x";
    const repeatY = ry === "repeat" || ry === "repeat-y";
    const startX = repeatX ? x + Math.floor((offset - left - x) / w) * w : x;
    const startY = repeatY ? y + Math.floor((-top - y) / h) * h : y;
    context.save();
    context.beginPath();
    context.rect(box.left - bounds.left, box.top - bounds.top, box.width, box.height);
    context.clip();
    for (let dy = startY; dy < height; dy += repeatY ? h : Infinity)
      for (
        let dx = startX;
        dx < (sliced ? offset + box.width : width);
        dx += repeatX ? w : Infinity
      ) {
        if (++draws > 2000) {
          context.restore();
          throw new Error("Background is too complex.");
        }
        context.drawImage(
          image,
          box.left - bounds.left + left + dx - offset,
          box.top - bounds.top + top + dy,
          w,
          h,
        );
      }
    context.restore();
    if (sliced) offset += box.width;
  }
}
