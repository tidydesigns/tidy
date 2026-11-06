export type DiagramImage = { url: string; width: number; height: number; description: string };

export function diagramImage(svg: string, dark = false): DiagramImage {
  if (svg.length > 1_000_000) throw new Error("This diagram is too large to preview.");
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = document.documentElement;
  const bounds = root
    .getAttribute("viewBox")
    ?.trim()
    .split(/[\s,]+/u)
    .map(Number);
  const width = bounds?.[2];
  const height = bounds?.[3];
  if (
    root.localName !== "svg" ||
    !width ||
    !height ||
    !Number.isFinite(width + height) ||
    width < 0 ||
    height < 0 ||
    root.querySelector("foreignObject,image")
  )
    throw new Error("This diagram could not be drawn.");
  const graphics = Array.from(
    root.querySelectorAll("path,rect,line,circle,ellipse,polygon,polyline,text"),
  );
  if (!graphics.some((element) => !element.closest("defs,marker,clipPath,mask")))
    throw new Error("This diagram has no content.");
  root.setAttribute("width", String(width));
  root.setAttribute("height", String(height));
  // Isolated images cannot inherit app colors; retain Pele's bindings and font metrics.
  const style = root.style;
  for (const property of ["max-width", "width", "height"]) style.removeProperty(property);
  const colors = {
    bg: dark ? "#171717" : "#fafafa",
    fg: dark ? "#ededed" : "#292929",
    muted: dark ? "#aaaaaa" : "#666666",
    line: dark ? "#aaaaaa" : "#666666",
    surface: dark ? "#292929" : "#f5f5f5",
    "surface-alt": dark ? "#333333" : "#eeeeee",
    border: dark ? "#777777" : "#aaaaaa",
  };
  for (const [name, value] of Object.entries(colors)) style.setProperty(`--pele-${name}`, value);
  return {
    url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`,
    width,
    height,
    description:
      Array.from(root.children)
        .filter((child) => child.localName === "title" || child.localName === "desc")
        .map((child) => child.textContent)
        .filter(Boolean)
        .join(". ") || "Mermaid diagram. Use Code to read its source.",
  };
}
