"use client";
import { useEffect, useMemo } from "react";
import type { DesignDocument, DesignNode } from "@/lib/design/document";
import {
  documentFontReferences,
  fontIdentity,
  fontIdentityKey,
  replaceDocumentFont,
  type FontReference,
} from "@/lib/design/fonts/recovery";
import { useFontRegistry } from "@/lib/design/fonts/use-document-fonts";
import { mapConcurrent } from "@/lib/map-concurrent";
import { FontPicker } from "./font-picker";

export function FontRecovery({
  document,
  onDocument,
}: {
  document: DesignDocument;
  onDocument: (update: (document: DesignDocument) => DesignDocument) => void;
}) {
  const registry = useFontRegistry();
  const references = useMemo(() => documentFontReferences(document), [document]);
  useEffect(() => {
    let active = true;
    const unique = [
      ...new Map(
        references.map((ref) => [
          JSON.stringify([
            fontIdentity(ref.style),
            ref.style.fontFace,
            ref.style.fontWeight,
            ref.style.fontStyle,
          ]),
          ref,
        ]),
      ).values(),
    ];
    void mapConcurrent(unique, 4, async ({ style, text }) => {
      if (active)
        await registry.load(
          style.fontFamily ?? "system-ui",
          style.fontWeight ?? 400,
          style.fontStyle === "italic",
          text,
          style.fontSource,
          style.fontFace,
        );
    });
    return () => {
      active = false;
    };
  }, [references, registry]);
  const failed = new Map<string, FontReference[]>();
  for (const ref of references) {
    const style = ref.style,
      status = registry.getStatus(
        style.fontFamily ?? "system-ui",
        style.fontWeight ?? 400,
        style.fontStyle === "italic",
        style.fontSource,
        style.fontFace,
      );
    if (status !== "missing" && status !== "error") continue;
    const key = fontIdentityKey(fontIdentity(style));
    failed.set(key, [...(failed.get(key) ?? []), ref]);
  }
  if (!failed.size) return null;
  return (
    <details className="border-t border-primary-grey/70 text-xs text-secondary-ink">
      <summary className="cursor-pointer px-3 py-3 font-medium hover:bg-primary-grey/15">
        Unavailable fonts · {failed.size}
      </summary>
      <div className="max-h-64 space-y-3 overflow-y-auto px-3 pb-3">
        {[...failed].map(([key, refs]) => {
          const identity = fontIdentity(refs[0].style),
            count = new Set(
              references
                .filter((ref) => fontIdentityKey(fontIdentity(ref.style)) === key)
                .map((ref) => ref.nodeId),
            ).size;
          const original = document.nodes.find((node) => node.id === refs[0].nodeId)!;
          const node: DesignNode = { ...original, style: refs[0].style };
          return (
            <div key={key} className="space-y-1">
              <p className="truncate text-primary-black" title={identity.family}>
                {identity.family}
                {identity.source === "local" ? " · Local" : ""}
              </p>
              <p>
                {count} {count === 1 ? "layer" : "layers"} across this file. Using a fallback on
                this device.
              </p>
              <FontPicker
                selected={[node]}
                familyOnly
                label={`Replace ${identity.family} throughout file`}
                onPatch={() => {}}
                onChoose={(font) =>
                  onDocument((current) => replaceDocumentFont(current, identity, font))
                }
              />
            </div>
          );
        })}
      </div>
    </details>
  );
}
