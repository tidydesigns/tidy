import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ExtraProps } from "react-markdown";
import { createPortal } from "react-dom";
import { Button } from "@tidy/ui/button";
import { Dialog } from "@tidy/editor/components/ui/dialog";
import { SelectMenu } from "@tidy/ui/select-menu";
import { showToast } from "@tidy/ui/toast";
import { formatTableCsv } from "./table-format";

const tableClassName =
  "w-full border-collapse text-sm leading-relaxed tabular-nums [overflow-wrap:normal] [word-break:normal] [&_:is(th,td)]:min-w-28 [&_:is(th,td)]:max-w-96 [&_:is(th,td)]:px-3 [&_:is(th,td)]:py-3 [&_:is(th,td)]:text-start [&_:is(th,td)]:align-top [&_:is(th,td)]:[overflow-wrap:anywhere] [&_:is(th,td)]:[text-wrap:pretty] [&_tr>:first-child]:ps-0 [&_tr>:last-child]:pe-0 [&_thead_th]:border-b [&_thead_th]:border-border/60 [&_thead_th]:pb-2.5 [&_thead_th]:pt-0 [&_thead_th]:text-xs [&_thead_th]:font-medium [&_thead_th]:text-muted-ink [&_tbody_tr:last-child_td]:pb-1 [&_td[style*=right]]:[overflow-wrap:normal] [&_td[style*=right]]:[direction:ltr] [&_td[style*=right]]:[unicode-bidi:isolate] [&_code]:[direction:ltr] [&_code]:[unicode-bidi:isolate] [&_code]:rounded-none! [&_code]:bg-transparent! [&_code]:p-0! [&_code]:text-[0.8125rem]!";

const actionClassName =
  "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded text-muted-ink hover:bg-hover-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink";

export function MarkdownTable({ children, node }: { children?: ReactNode } & ExtraProps) {
  const [expanded, setExpanded] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const table = useRef<HTMLTableElement>(null);
  const markdown = node?.properties["data-markdown-source"];

  function copy(format: string) {
    if (!table.current || (format !== "markdown" && format !== "csv")) return;
    if (format === "markdown" && typeof markdown !== "string") return;
    const content =
      format === "markdown" && typeof markdown === "string"
        ? markdown
        : formatTableCsv(
            Array.from(table.current.rows, (row) =>
              Array.from(row.cells, (cell) => cell.innerText),
            ),
          );
    void navigator.clipboard.writeText(content).then(
      () => showToast("Table copied", "success"),
      () => showToast("Could not copy table", "error"),
    );
  }

  useLayoutEffect(() => {
    if (expanded) dialog.current?.showModal();
  }, [expanded]);

  return (
    <div className="my-[0.65rem] min-w-0 max-w-full">
      <div className="markdown-table-scroll" tabIndex={0} role="region" aria-label="Table">
        <table ref={table} className={tableClassName}>
          {children}
        </table>
      </div>
      <div className="mt-2 flex items-center justify-end gap-0.5 select-none">
        <Button
          variant="text"
          className={actionClassName}
          title="Expand table"
          aria-label="Expand table"
          aria-haspopup="dialog"
          onClick={() => setExpanded(true)}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />
          </svg>
        </Button>
        <SelectMenu
          actionMenu
          value=""
          label="Copy table"
          align="end"
          triggerClassName={actionClassName}
          triggerContent={
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <rect x="8" y="8" width="13" height="13" rx="2" />
              <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
            </svg>
          }
          options={[
            {
              value: "markdown",
              label: "Copy as Markdown",
              disabled: typeof markdown !== "string",
            },
            { value: "csv", label: "Copy as CSV" },
          ]}
          onChange={copy}
        />
      </div>
      {expanded &&
        createPortal(
          <Dialog
            ref={dialog}
            size="wide"
            padded={false}
            className="markdown-table-dialog"
            aria-label="Expanded table"
            onClose={() => setExpanded(false)}
          >
            <div className="markdown-table-toolbar">
              <Button
                variant="text"
                className="markdown-table-action"
                autoFocus
                onClick={() => dialog.current?.close()}
              >
                Close
              </Button>
            </div>
            <div className="message-markdown markdown-table-content">
              <div className="markdown-table-scroll" tabIndex={0} role="region" aria-label="Table">
                <table className={tableClassName}>{children}</table>
              </div>
            </div>
          </Dialog>,
          document.body,
        )}
    </div>
  );
}
