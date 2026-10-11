import { decodeCaptureImage, isProtectedElement } from "./capture-effects";

// Render an isolated, inert clone in SVG foreignObject. The browser applies the
// original masks, with transparent pixels around the group. 3D scenes need
// a real browser screenshot; foreignObject does not preserve their compositing.
// Nothing is inserted into or restyled on the live page.
export async function rasterizeElement(element: Element, bounds: DOMRect): Promise<string> {
  const deadline = performance.now() + 3000;
  const signal = AbortSignal.timeout(3000);
  let resourceBytes = 0;
  let markupBytes = 0;
  let lastYield = performance.now();
  const checkBudget = (bytes = 0) => {
    markupBytes += bytes;
    if (performance.now() > deadline || markupBytes > 12_000_000)
      throw new Error("Visual group exceeds the rendering budget.");
  };
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
    if (url.startsWith("data:")) {
      if (url.length > 6_700_000) return Promise.reject(new Error("Visual resource too large."));
      return Promise.resolve(url);
    }
    const absolute = new URL(url, document.baseURI).href;
    if (!/^(https?:|blob:)/.test(absolute))
      return Promise.reject(new Error("Unsupported resource."));
    if (!resources.has(absolute))
      resources.set(
        absolute,
        (async () => {
          checkBudget();
          const response = await fetch(absolute, { signal });
          if (!response.ok) throw new Error("Could not read a visual resource.");
          if (Number(response.headers.get("content-length")) + resourceBytes > 5_000_000) {
            await response.body?.cancel();
            throw new Error("Visual resources too large.");
          }
          const reader = response.body?.getReader();
          if (!reader) throw new Error("Visual resource body missing.");
          const chunks: Uint8Array<ArrayBuffer>[] = [];
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              resourceBytes += value.byteLength;
              if (resourceBytes > 5_000_000) {
                await reader.cancel();
                throw new Error("Visual resources too large.");
              }
              chunks.push(new Uint8Array(value));
            }
          } finally {
            reader.releaseLock();
          }
          const blob = new Blob(chunks, {
            type: response.headers.get("content-type") ?? "application/octet-stream",
          });
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
  const references = new Set<Element>();
  const svgNamespace = "http://www.w3.org/2000/svg";
  // Keep referenced geometry inert and self-contained while preserving SVG
  // inheritance from the use host, particularly fill/stroke=currentColor.
  const symbolClone = async (source: Element): Promise<Element> => {
    checkBudget();
    if (++count > 2000) throw new Error("SVG reference is too complex.");
    if (
      source.namespaceURI !== svgNamespace ||
      ["script", "foreignObject", "image", "use", "a"].includes(source.localName)
    )
      throw new Error("SVG reference needs a screenshot.");
    const target = source.cloneNode(false) as SVGElement;
    for (const attribute of [...target.attributes]) {
      if (/^on/i.test(attribute.name) || /^(?:href|xlink:href)$/i.test(attribute.name))
        target.removeAttribute(attribute.name);
      else if (attribute.value.includes("url("))
        target.setAttribute(attribute.name, await inlineUrls(attribute.value));
    }
    for (const name of [...target.style])
      target.style.setProperty(name, await inlineUrls(target.style.getPropertyValue(name)));
    for (const child of source.childNodes) {
      if (child instanceof Element) target.append(await symbolClone(child));
      else if (child.nodeType === Node.TEXT_NODE) target.append(child.cloneNode());
    }
    checkBudget(new XMLSerializer().serializeToString(target).length);
    return target;
  };
  const clone = async (source: Element): Promise<Element | undefined> => {
    checkBudget();
    if (performance.now() - lastYield > 8) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
    if (++count > 2000) throw new Error("Visual group too complex.");
    if (isProtectedElement(source))
      throw new Error("Protected content needs a redacted screenshot.");
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
    const isUse = source.localName === "use" && source.namespaceURI === svgNamespace;
    const href = isUse && (source.getAttribute("href") || source.getAttribute("xlink:href"));
    const reference =
      href && href.startsWith("#") ? source.ownerDocument.getElementById(href.slice(1)) : null;
    if (isUse && (!reference || references.has(reference)))
      throw new Error("SVG symbol is unavailable.");
    const target = isUse
      ? document.createElementNS(svgNamespace, "svg")
      : (source.cloneNode(false) as HTMLElement | SVGElement);
    if (isUse) {
      for (const attribute of [...source.attributes])
        target.setAttribute(attribute.name, attribute.value);
      if (reference!.localName === "symbol") {
        const viewBox = reference!.getAttribute("viewBox");
        if (viewBox) target.setAttribute("viewBox", viewBox);
        target.setAttribute(
          "preserveAspectRatio",
          reference!.getAttribute("preserveAspectRatio") || "xMidYMid meet",
        );
      }
    }
    // Keep structural SVG attributes but never event handlers or live resources.
    for (const attribute of [...target.attributes]) {
      if (
        /^on/i.test(attribute.name) ||
        ["src", "srcset", "href", "xlink:href", "value", "autofocus"].includes(attribute.name)
      )
        target.removeAttribute(attribute.name);
    }
    for (const name of css) {
      checkBudget();
      target.style.setProperty(name, await inlineUrls(css.getPropertyValue(name)), "important");
    }
    target.style.setProperty("animation", "none", "important");
    target.style.setProperty("transition", "none", "important");
    // Freeze computed transforms, rather than advancing the animation in the clone.
    if (source instanceof HTMLImageElement)
      target.setAttribute("src", await embed(source.currentSrc || source.src));
    if (isUse) {
      references.add(reference!);
      try {
        const geometry = await symbolClone(reference!);
        if (reference!.localName === "symbol") target.append(...geometry.childNodes);
        else target.append(geometry);
      } finally {
        references.delete(reference!);
      }
    }
    checkBudget(new XMLSerializer().serializeToString(target).length);
    // Generated visuals need their CSS too. Materialize pseudo-elements without
    // changing the source document or relying on its stylesheets.
    const pseudo = async (selector: string) => {
      const style = getComputedStyle(source, selector);
      if (!style.content || ["none", "normal"].includes(style.content)) return;
      const span = document.createElement("span");
      for (const name of style)
        span.style.setProperty(name, await inlineUrls(style.getPropertyValue(name)), "important");
      if (style.display === "none" || style.visibility === "hidden") return;
      if (/^["']/.test(style.content)) {
        const matches = [...style.content.matchAll(/"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g)];
        if (!matches.length) throw new Error("Unsupported generated content.");
        span.textContent = matches
          .map((match) =>
            (match[1] ?? match[2] ?? "").replace(
              /\\([\da-f]{1,6})\s?|\\([^\n\r\f])/gi,
              (_match, hex: string | undefined, escaped: string | undefined) =>
                hex
                  ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd)
                  : escaped!,
            ),
          )
          .join("");
      } else if (/^url\(/.test(style.content)) {
        const img = document.createElement("img");
        const resource = style.content.match(/^url\(["']?([^"')]+)["']?\)/)?.[1];
        if (!resource) throw new Error("Unsupported generated image.");
        img.src = await embed(resource);
        img.style.cssText = "width:100%;height:100%;object-fit:contain";
        span.append(img);
      } else throw new Error("Unsupported generated content.");
      span.style.setProperty("content", "normal", "important");
      checkBudget(new XMLSerializer().serializeToString(span).length);
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
  await decodeCaptureImage(image, deadline - performance.now());
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable.");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png").split(",")[1]!;
}
