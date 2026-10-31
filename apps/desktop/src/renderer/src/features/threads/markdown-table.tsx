import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Button } from "@tidy/ui/button";
import { Dialog } from "@tidy/editor/components/ui/dialog";

export function MarkdownTable({ children }: { children?: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useLayoutEffect(() => {
    if (expanded) dialog.current?.showModal();
  }, [expanded]);

  return (
    <div className="markdown-table">
      <div className="markdown-table-toolbar">
        <Button
          variant="text"
          className="markdown-table-action"
          aria-haspopup="dialog"
          onClick={() => setExpanded(true)}
        >
          Expand table
        </Button>
      </div>
      <div className="markdown-table-scroll" tabIndex={0} role="region" aria-label="Table">
        <table>{children}</table>
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
                <table>{children}</table>
              </div>
            </div>
          </Dialog>,
          document.body,
        )}
    </div>
  );
}
