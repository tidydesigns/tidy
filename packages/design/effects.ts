import type { DesignNode, DesignEffect } from "./document";
export type Shadow = NonNullable<DesignNode["style"]["shadows"]>[number] & { id: string };
type Style = DesignNode["style"];
export const effectControls = {
  blur: { label: "Blur", min: 0, max: 100, initial: 4, unit: "px" },
  brightness: { label: "Brightness", min: 0, max: 200, initial: 100, unit: "%" },
  contrast: { label: "Contrast", min: 0, max: 200, initial: 100, unit: "%" },
  grayscale: { label: "Grayscale", min: 0, max: 100, initial: 100, unit: "%" },
  saturation: { label: "Saturation", min: 0, max: 200, initial: 100, unit: "%" },
  hueRotate: { label: "Hue rotation", min: -360, max: 360, initial: 0, unit: "°" },
} as const;
export function nodeEffects(style: Style): DesignEffect[] {
  return (
    style.effects ??
    (Object.keys(effectControls) as DesignEffect["type"][]).flatMap((type) =>
      style[type] !== undefined &&
      !(style[type] === 0 && ["blur", "grayscale", "hueRotate"].includes(type))
        ? [{ id: `legacy-${type}`, type, amount: style[type]!, visible: true }]
        : [],
    )
  );
}
export function effectStyle(effects: DesignEffect[]): Partial<Style> {
  return {
    effects,
    blur: undefined,
    brightness: undefined,
    contrast: undefined,
    grayscale: undefined,
    saturation: undefined,
    hueRotate: undefined,
  };
}
export function effectCss(style: Style) {
  return (
    nodeEffects(style)
      .filter((effect) => effect.visible)
      .map((effect) =>
        effect.type === "hueRotate"
          ? `hue-rotate(${effect.amount}deg)`
          : `${effect.type === "saturation" ? "saturate" : effect.type}(${effect.amount}${effect.type === "blur" ? "px" : "%"})`,
      )
      .join(" ") || undefined
  );
}

function cssColor(value: string, currentColor: string): string | undefined {
  if (value.length > 128) return;
  if (value === "currentcolor") return currentColor;
  const named: Record<string, string> = {
    transparent: "#00000000",
    black: "#000000",
    white: "#ffffff",
    red: "#ff0000",
    blue: "#0000ff",
    green: "#008000",
  };
  if (named[value]) return named[value];
  if (/^#[\da-f]{3,4}$/i.test(value))
    return `#${value
      .slice(1)
      .split("")
      .map((part) => part + part)
      .join("")}`;
  if (/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value)) return value;
  const match = value.match(
    /^rgba?\(\s*([\d.]+)(%)?[,\s]+([\d.]+)(%)?[,\s]+([\d.]+)(%)?(?:\s*[,/]\s*([\d.]+)(%)?)?\s*\)$/,
  );
  if (!match) return;
  const byte = (channel: number) =>
    Math.max(0, Math.min(255, Math.round(channel)))
      .toString(16)
      .padStart(2, "0");
  return `#${[1, 3, 5].map((index) => byte(Number(match[index]) * (match[index + 1] ? 2.55 : 1))).join("")}${match[7] ? byte(Number(match[7]) * (match[8] ? 2.55 : 255)) : ""}`;
}

/** Split only outside a color function; reject incomplete or nested functions. */
function shadowParts(source: string, separator: "," | " "): string[] | undefined {
  const parts: string[] = [];
  let start = 0;
  let inFunction = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (character === "(") {
      if (inFunction) return;
      inFunction = true;
    } else if (character === ")") {
      if (!inFunction) return;
      inFunction = false;
    } else if (!inFunction && (separator === "," ? character === "," : /\s/.test(character!))) {
      const part = source.slice(start, index).trim();
      if (part) parts.push(part);
      else if (separator === ",") return;
      start = index + 1;
      if (parts.length > 20) return;
    }
  }
  if (inFunction) return;
  const last = source.slice(start).trim();
  if (last) parts.push(last);
  else if (separator === ",") return;
  return parts.length && parts.length <= 20 ? parts : undefined;
}
/** Parse computed CSS shadows without dropping a shadow that cannot be represented. */
export function parseCssShadows(
  source: string | undefined,
  prefix = "imported",
  currentColor = "#000000",
): Shadow[] | undefined {
  // Computed CSS may exceed the stored legacy field's 160-character limit.
  if (source && source.length > 4096) return;
  if (!source || source.trim() === "none") return [];
  const parts = shadowParts(source, ",");
  if (!parts || parts.length > 20) return;
  const shadows: Shadow[] = [];
  for (const [index, part] of parts.entries()) {
    const tokens = shadowParts(part.toLowerCase(), " ");
    if (!tokens) return;
    const inset = tokens.includes("inset");
    if (tokens.filter((token) => token === "inset").length > 1) return;
    const numbers: number[] = [];
    let color: string | undefined;
    for (const token of tokens.filter((token) => token !== "inset")) {
      if (/^-?(?:\d*\.)?\d+(?:px)?$/.test(token)) {
        const value = parseFloat(token);
        if (!token.endsWith("px") && value !== 0) return;
        numbers.push(value);
      } else {
        if (color) return;
        color = cssColor(token, currentColor);
        if (!color) return;
      }
    }
    if (
      numbers.length < 2 ||
      numbers.length > 4 ||
      numbers.some((value) => !Number.isFinite(value) || Math.abs(value) > 1000) ||
      (numbers[2] ?? 0) < 0
    )
      return;
    shadows.push({
      id: `${prefix}-${index}`,
      x: numbers[0]!,
      y: numbers[1]!,
      blur: numbers[2] ?? 0,
      spread: numbers[3] ?? 0,
      color: color ?? currentColor,
      inset,
      visible: true,
    });
  }
  return shadows;
}
function importedShadows(style: Style) {
  let outer = parseCssShadows(style.shadow, "imported-outer", style.color),
    inner = parseCssShadows(style.innerShadow, "imported-inner", style.color)?.map((shadow) => ({
      ...shadow,
      inset: true,
    }));
  let capacity = 20 - (style.shadows?.length ?? 0);
  if (outer && outer.length <= capacity) capacity -= outer.length;
  else outer = undefined;
  if (inner && inner.length > capacity) inner = undefined;
  return { outer, inner };
}
export function nodeShadows(style: Style): Shadow[] {
  const imported = importedShadows(style);
  const used = new Set<string>();
  return [...(imported.outer ?? []), ...(imported.inner ?? []), ...(style.shadows ?? [])].map(
    (shadow, index) => {
      let id = shadow.id ?? `shadow-${index}`;
      for (let suffix = 1; used.has(id); suffix++) id = `shadow-${index}-${suffix}`;
      used.add(id);
      return { ...shadow, id };
    },
  );
}
/** Promote parseable legacy fields on edit; preserve unsupported CSS verbatim. */
export function shadowStyle(style: Style, shadows: Shadow[]): Partial<Style> {
  const imported = importedShadows(style);
  return {
    shadows,
    shadow: imported.outer ? undefined : style.shadow,
    innerShadow: imported.inner ? undefined : style.innerShadow,
  };
}
export function shadowCss(style: Style) {
  return (
    [
      style.shadow,
      style.innerShadow ? `inset ${style.innerShadow.replace(/^inset\s+/i, "")}` : undefined,
      ...(style.shadows ?? [])
        .filter((shadow) => shadow.visible)
        .map(
          (shadow) =>
            `${shadow.inset ? "inset " : ""}${shadow.x}px ${shadow.y}px ${shadow.blur}px ${shadow.spread}px ${shadow.color}`,
        ),
    ]
      .filter(Boolean)
      .join(", ") || undefined
  );
}
/** Reorder the requested identity against the latest stack, preserving intervening edits. */
export function moveEffect<T extends { id: string }>(
  effects: T[],
  id: string,
  direction: -1 | 1,
): T[] {
  const index = effects.findIndex((effect) => effect.id === id),
    target = index + direction;
  if (index < 0 || target < 0 || target >= effects.length) return effects;
  const next = [...effects];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
