import { useState, type ComponentProps } from "react";
import type { ExtraProps } from "react-markdown";
import { Button } from "@tidy/ui/button";
import { ClipboardCopyButton } from "./message-copy-button";

export function MarkdownCodeBlock({ children, node }: ComponentProps<"pre"> & ExtraProps) {
  const [wrapped, setWrapped] = useState(true);
  const code = node?.children.find((child) => child.type === "element" && child.tagName === "code");
  if (code?.type !== "element") return <pre>{children}</pre>;
  const text = code.children.map((child) => (child.type === "text" ? child.value : "")).join("");
  const classes = code.properties.className;
  const language = (Array.isArray(classes) ? classes : [])
    .find((value) => typeof value === "string" && value.startsWith("language-"))
    ?.toString()
    .slice(9);
  const label = language === "md" ? "markdown" : language || "text";
  const wrapLabel = wrapped ? "Disable line wrap" : "Wrap lines";

  return (
    <div className="markdown-code-block" data-wrap={wrapped} dir="ltr">
      <div className="markdown-code-header">
        <span className="markdown-code-language" title={label}>
          {label}
        </span>
        <div className="markdown-code-actions" role="toolbar" aria-label="Code block actions">
          <Button
            type="button"
            className="markdown-code-wrap"
            aria-label={wrapLabel}
            title={wrapLabel}
            aria-pressed={wrapped}
            onClick={() => setWrapped((value) => !value)}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3 6h18M3 12h14a3 3 0 0 1 0 6h-4m3-3-3 3 3 3M3 18h4" />
            </svg>
          </Button>
          <ClipboardCopyButton
            label="Copy code"
            copiedDurationMs={1000}
            onCopy={() => navigator.clipboard.writeText(text)}
          />
        </div>
      </div>
      <pre tabIndex={0} role="region" aria-label={`${label} code`}>
        {children}
      </pre>
    </div>
  );
}
