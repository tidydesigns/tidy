"use client";

import type { DesignDocument } from "../design/document";
import { renameColorToken, removeColorToken } from "../design/tokens";
import { normalizeColor } from "../design/selection-colors";
import { PropertyField } from "./property-field";
import { AddToken, DesignTokenEditor } from "./design-token-editor";

export function ColorTokens({
  document,
  onChange,
}: {
  document: DesignDocument;
  onChange: (transform: (content: DesignDocument) => DesignDocument) => void;
}) {
  return (
    <div className="space-y-3 p-3">
      <AddToken onChange={onChange} />
      {Object.entries(document.designTokens ?? {}).map(([name, token]) => (
        <DesignTokenEditor
          key={name}
          document={document}
          name={name}
          token={token}
          onChange={onChange}
        />
      ))}
      {Object.entries(document.tokens).map(([name, value]) => (
        <div key={name} className="space-y-2 rounded-md border border-primary-grey/60 p-2">
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <PropertyField
                replayLabel
                label="Token name"
                value={name}
                onCommit={(next) =>
                  onChange((content) => renameColorToken(content, name, next.trim()))
                }
              />
            </div>
            <button
              data-ph-public
              type="button"
              aria-label={`Remove token ${name}`}
              onClick={() => onChange((content) => removeColorToken(content, name))}
              className="h-8 w-7 rounded text-secondary-ink hover:bg-primary-grey/25 focus-visible:outline-2 focus-visible:outline-primary-orange"
            >
              −
            </button>
          </div>
          <div className="flex items-end gap-2">
            <input
              type="color"
              aria-label={`Color for token ${name}`}
              value={value.slice(0, 7)}
              onChange={(event) => {
                const color = event.target.value + (value.length === 9 ? value.slice(7) : "");
                onChange((content) => ({
                  ...content,
                  tokens: { ...content.tokens, [name]: color },
                }));
              }}
              className="h-8 w-8 shrink-0 cursor-pointer rounded border border-primary-grey/70 bg-surface p-0.5"
            />
            <div className="min-w-0 flex-1">
              <PropertyField
                replayLabel
                label="Color"
                value={value}
                validate={(color) =>
                  normalizeColor(color)
                    ? undefined
                    : "Enter a hex color such as #336699 or #336699ff."
                }
                onCommit={(color) =>
                  onChange((content) => ({
                    ...content,
                    tokens: { ...content.tokens, [name]: color },
                  }))
                }
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
