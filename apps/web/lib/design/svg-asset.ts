import { DOMImplementation, DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { PublicActionError } from "../security/public-error";

const svgNamespace = "http://www.w3.org/2000/svg";
const xlinkNamespace = "http://www.w3.org/1999/xlink";
const elements = new Set(
  `svg g defs symbol use path rect circle ellipse line polyline polygon
  text tspan textPath title desc style clipPath mask pattern linearGradient radialGradient stop
  marker image filter feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix
  feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB feFuncG
  feFuncR feGaussianBlur feMerge feMergeNode feMorphology feOffset fePointLight feSpecularLighting
  feSpotLight feTile feTurbulence`.split(/\s+/),
);
const attributes = new Set(
  `id class style x y x1 y1 x2 y2 dx dy width height rx ry cx cy r d points
  viewBox preserveAspectRatio transform fill fill-opacity fill-rule stroke stroke-width
  stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset
  opacity color display visibility overflow vector-effect paint-order shape-rendering
  text-rendering image-rendering color-rendering color-interpolation color-interpolation-filters
  clip-path clip-rule mask filter marker-start marker-mid marker-end
  gradientUnits gradientTransform spreadMethod offset stop-color stop-opacity fx fy fr
  patternUnits patternContentUnits patternTransform clipPathUnits maskUnits maskContentUnits
  markerUnits markerWidth markerHeight refX refY orient
  font-family font-size font-style font-weight font-stretch font-variant letter-spacing word-spacing
  text-anchor text-decoration dominant-baseline alignment-baseline baseline-shift textLength
  lengthAdjust rotate startOffset method spacing in in2 result mode type values operator
  k1 k2 k3 k4 stdDeviation edgeMode kernelMatrix kernelUnitLength order targetX targetY
  preserveAlpha divisor bias scale xChannelSelector yChannelSelector radius surfaceScale
  diffuseConstant specularConstant specularExponent limitingConeAngle azimuth elevation
  pointsAtX pointsAtY pointsAtZ z lighting-color flood-color flood-opacity baseFrequency
  numOctaves seed stitchTiles tableValues slope intercept amplitude exponent filterUnits
  primitiveUnits version role aria-label aria-hidden focusable`.split(/\s+/),
);
const fragment = /^#[A-Za-z_][\w.:-]*$/;
function invalid(): never {
  throw new PublicActionError(
    "SVG contains unsupported content. Export it as a static image and try again.",
  );
}
function safeValue(value: string) {
  // Keep presentation CSS and local paint references; disallow indirect syntax.
  if (/[\\@\u0000-\u0008\u000b\u000c\u000e-\u001f]|\/\*|\*\/|expression\s*\(/i.test(value))
    invalid();
  const rest = value.replace(/url\(\s*(['"]?)(#[A-Za-z_][\w.:-]*)\1\s*\)/gi, "");
  if (/url\s*\(/i.test(rest)) invalid();
}

/** Normalize static image content identically at ingestion and export. */
export function sanitizeSvgAsset(source: string): string {
  if (!source || source.length > 2_000_000 || /<!DOCTYPE|<!ENTITY/i.test(source)) invalid();
  const parsed = new DOMParser({
    errorHandler: { warning: invalid, error: invalid, fatalError: invalid },
  }).parseFromString(source, "image/svg+xml");
  const root = parsed.documentElement;
  if (!root || root.localName !== "svg") invalid();
  for (let node = parsed.firstChild; node; node = node.nextSibling) {
    if (node === root || node.nodeType === 8 || (node.nodeType === 3 && !node.nodeValue?.trim()))
      continue;
    if (node.nodeType === 7 && node.nodeName === "xml") continue;
    invalid();
  }
  const output = new DOMImplementation().createDocument(svgNamespace, "svg", null);
  let count = 0;
  const copy = (input: Element, target: Element, depth: number) => {
    if (
      ++count > 50_000 ||
      depth > 128 ||
      (input.namespaceURI && input.namespaceURI !== svgNamespace) ||
      !elements.has(input.localName)
    )
      invalid();
    if (input.localName === "style") safeValue(input.textContent ?? "");
    for (let i = 0; i < input.attributes.length; i++) {
      const attribute = input.attributes.item(i)!;
      if (attribute.namespaceURI === "http://www.w3.org/2000/xmlns/") continue;
      const name = attribute.localName;
      if (
        attribute.namespaceURI === "http://www.w3.org/XML/1998/namespace" &&
        ["space", "lang"].includes(name)
      ) {
        target.setAttributeNS(attribute.namespaceURI, `xml:${name}`, attribute.value);
        continue;
      }
      if (
        name === "href" &&
        (!attribute.namespaceURI || attribute.namespaceURI === xlinkNamespace)
      ) {
        if (!fragment.test(attribute.value)) invalid();
        target.setAttribute("href", attribute.value);
        continue;
      }
      if (attribute.namespaceURI || !attributes.has(name)) invalid();
      safeValue(attribute.value);
      target.setAttribute(name, attribute.value);
    }
    for (let child = input.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1) {
        const element = child as Element;
        const next = output.createElementNS(svgNamespace, element.localName);
        target.appendChild(next);
        copy(element, next, depth + 1);
      } else if (child.nodeType === 3 || child.nodeType === 4) {
        target.appendChild(output.createTextNode(child.nodeValue ?? ""));
      } else if (child.nodeType !== 8) invalid();
    }
  };
  copy(root, output.documentElement, 0);
  const serialized = new XMLSerializer().serializeToString(output);
  if (new TextEncoder().encode(serialized).length > 2_000_000) invalid();
  return serialized;
}
