import type { DesignNode } from "../../design/document";
import { PropertyField } from "../property-field";
import { shared, type Patch } from "../inspector-controls";
type Style = DesignNode["style"];
type NumericStyleKey = {
  [Key in keyof Style]-?: Style[Key] extends number | undefined ? Key : never;
}[keyof Style];
export const inspectorButtonClass =
  "rounded-md border border-transparent bg-hover-surface px-2 py-1.5 text-xs hover:bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-primary-orange";
const fieldLabels: Readonly<Record<string, string | undefined>> = {
  Width: "W",
  Height: "H",
  "Font size": "Size",
  "Letter spacing": "Tracking",
  "Line height %": "Line %",
  "Line height px": "Line px",
  "Top left radius": "Top left",
  "Top right radius": "Top right",
  "Bottom left radius": "Bottom left",
  "Bottom right radius": "Bottom right",
  "Padding top": "Top",
  "Padding right": "Right",
  "Padding bottom": "Bottom",
  "Padding left": "Left",
  "Border top": "Top",
  "Border right": "Right",
  "Border bottom": "Bottom",
  "Border left": "Left",
};
export function selectionFields(selected: DesignNode[], onPatch: (changes: Patch) => void) {
  const common = <T,>(get: (node: DesignNode) => T) => shared(selected, get);
  const numberField = (
    label: string,
    get: (node: DesignNode) => number | undefined,
    patch: (value: number | undefined) => Patch,
    min?: number,
    max?: number,
    optional = false,
    step: number | "any" = "any",
  ) => (
    <PropertyField
      replayLabel
      key={label}
      label={label}
      displayLabel={fieldLabels[label]}
      value={common(get)}
      numeric
      min={min}
      max={max}
      step={step}
      onCommit={(value) => {
        if (value !== "" || optional) onPatch(patch(value === "" ? undefined : Number(value)));
      }}
    />
  );
  const styleNumber = (
    label: string,
    key: NumericStyleKey,
    fallback: number,
    min: number,
    max: number,
  ) =>
    numberField(
      label,
      (item) => item.style[key] ?? fallback,
      (value) => ({ style: { [key]: value } }),
      min,
      max,
    );
  return { common, numberField, styleNumber };
}
