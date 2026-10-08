// Render an isolated, inert clone in SVG foreignObject. The browser applies the
// original masks, with transparent pixels around the group. 3D scenes need
// a real browser screenshot; foreignObject does not preserve their compositing.
// Nothing is inserted into or restyled on the live page.
export async function rasterizeElement(element: Element, bounds: DOMRect): Promise<string> {
  const rootCss = getComputedStyle(element);
  // Perspective/3D on a parent must be captured with that parent, not a child.
  if (
    (rootCss.perspective && rootCss.perspective !== "none") ||
    rootCss.transformStyle === "preserve-3d" ||
    rootCss.transform.startsWith("matrix3d(")
  )
    throw new Error("Capture the perspective parent.");
  const resources = new Map<string, Promise<string>>();
  const embed = (url: string): Promise<string> => {
    if (url.startsWith("data:")) return Promise.resolve(url);
    const absolute = new URL(url, document.baseURI).href;
    if (!/^(https?:|blob:)/.test(absolute))
      return Promise.reject(new Error("Unsupported resource."));
    if (!resources.has(absolute))
      resources.set(
        absolute,
        (async () => {
          const response = await fetch(absolute, { signal: AbortSignal.timeout(3000) });
          if (!response.ok) throw new Error("Could not read a visual resource.");
          const blob = await response.blob();
          if (blob.size > 5_000_000) throw new Error("Visual resource too large.");
          return await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        })(),
      );
    return resources.get(absolute)!;
  };
  const inlineUrls = async (value: string) => {
    const matches = [...value.matchAll(/url\(["']?([^"')]+)["']?\)/g)];
    for (const match of matches) {
      if (match[1]!.startsWith("#")) continue;
      value = value.replace(match[0], `url("${await embed(match[1]!)}")`);
    }
    return value;
  };
  let count = 0;
  const clone = async (source: Element): Promise<Element | undefined> => {
    if (++count > 2000) throw new Error("Visual group too complex.");
    if (["SCRIPT", "STYLE", "LINK", "NOSCRIPT", "TEMPLATE"].includes(source.tagName.toUpperCase()))
      return undefined;
    if (
      source.shadowRoot ||
      ["IFRAME", "OBJECT", "EMBED", "VIDEO", "CANVAS"].includes(source.tagName)
    )
      throw new Error("Visual group needs a screenshot.");
    const css = getComputedStyle(source);
    if (css.display === "none") return undefined;
    if (
      (css.perspective && css.perspective !== "none") ||
      css.transform.startsWith("matrix3d(") ||
      css.transformStyle === "preserve-3d"
    )
      throw new Error("3D composition needs a screenshot.");
    if (
      (css.mixBlendMode && css.mixBlendMode !== "normal") ||
      (css.backdropFilter && css.backdropFilter !== "none")
    )
      throw new Error("Backdrop-dependent group needs a screenshot.");
    const target = source.cloneNode(false) as HTMLElement | SVGElement;
    // Keep structural SVG attributes but never event handlers or live resources.
    for (const attribute of [...target.attributes]) {
      if (
        /^on/i.test(attribute.name) ||
        ["src", "srcset", "href", "xlink:href", "value", "autofocus"].includes(attribute.name)
      )
        target.removeAttribute(attribute.name);
    }
    for (const name of css)
      target.style.setProperty(name, await inlineUrls(css.getPropertyValue(name)), "important");
    target.style.setProperty("animation", "none", "important");
    target.style.setProperty("transition", "none", "important");
    // Freeze computed transforms, rather than advancing the animation in the clone.
    if (source instanceof HTMLImageElement)
      target.setAttribute("src", await embed(source.currentSrc || source.src));
    if (source.tagName.toLowerCase() === "use") throw new Error("SVG symbols need a screenshot.");
    // Generated visuals need their CSS too. Materialize pseudo-elements without
    // changing the source document or relying on its stylesheets.
    const pseudo = async (selector: string) => {
      const style = getComputedStyle(source, selector);
      if (!style.content || ["none", "normal"].includes(style.content)) return;
      const span = document.createElement("span");
      for (const name of style)
        span.style.setProperty(name, await inlineUrls(style.getPropertyValue(name)), "important");
      if (style.content === '""' || style.content === "''") span.textContent = "";
      else throw new Error("Unsupported generated content.");
      target.append(span);
    };
    await pseudo("::before");
    if (
      !source.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
    ) {
      for (const child of source.childNodes) {
        if (child instanceof Element) {
          const copy = await clone(child);
          if (copy) target.append(copy);
        } else if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim())
          throw new Error("Text with webfonts needs a screenshot.");
      }
    }
    await pseudo("::after");
    return target;
  };
  const copy = (await clone(element)) as HTMLElement | SVGElement | undefined;
  if (!copy) throw new Error("Nothing to rasterize.");
  const borderBox = element.getBoundingClientRect();
  if (
    element instanceof HTMLElement &&
    (Math.abs(borderBox.width - element.offsetWidth) > 1 ||
      Math.abs(borderBox.height - element.offsetHeight) > 1)
  )
    throw new Error("Ancestor scaling needs a screenshot.");
  const matrix = new DOMMatrix(rootCss.transform === "none" ? undefined : rootCss.transform);
  if (
    !matrix.is2D ||
    matrix.b !== 0 ||
    matrix.c !== 0 ||
    Math.abs(matrix.a) !== 1 ||
    Math.abs(matrix.d) !== 1
  )
    throw new Error("Root rotation/scale needs a screenshot.");
  // The root is now positioned in the raster canvas. Preserve flips but remove
  // the page's translation, which is already represented by the imported box.
  matrix.e = 0;
  matrix.f = 0;
  for (const [name, value] of Object.entries({
    position: "absolute",
    left: `${borderBox.left - bounds.left}px`,
    top: `${borderBox.top - bounds.top}px`,
    right: "auto",
    bottom: "auto",
    margin: "0",
    transform: matrix.toString(),
  }))
    copy.style.setProperty(name, value, "important");
  const host = document.createElement("div");
  host.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  host.style.cssText = `position:relative;width:${bounds.width}px;height:${bounds.height}px;overflow:hidden`;
  host.append(copy);
  const markup = new XMLSerializer().serializeToString(host);
  if (markup.length > 12_000_000) throw new Error("Visual group too large.");
  const canvas = document.createElement("canvas");
  const scale = Math.min(
    window.devicePixelRatio || 1,
    4096 / Math.max(bounds.width, bounds.height),
  );
  canvas.width = Math.ceil(bounds.width * scale);
  canvas.height = Math.ceil(bounds.height * scale);
  // Give the SVG a physical-pixel intrinsic size. Upscaling a CSS-sized decoded
  // foreignObject afterwards would blur the forest on Retina screens.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${bounds.width} ${bounds.height}"><foreignObject width="100%" height="100%">${markup}</foreignObject></svg>`;
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png").split(",")[1]!;
}
