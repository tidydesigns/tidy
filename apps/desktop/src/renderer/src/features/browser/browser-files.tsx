import { useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { BrowserIconButton, Glyph } from "./browser-controls";
import type { BrowserAPI, BrowserState } from "../../../../shared/contracts/browser";
import type { useBrowserSession } from "./use-browser-session";
type Command = ReturnType<typeof useBrowserSession>["command"];
export function BrowserFileChooser({
  chooser,
  enabled,
  command,
  setError,
}: {
  chooser: NonNullable<BrowserState["fileChooser"]>;
  enabled: boolean;
  command: Command;
  setError(message: string): void;
}) {
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <div className="browser-file-picker flex items-center gap-2 border-b border-border px-3 py-2 text-[11px] text-secondary-ink">
      <span className="flex-1">
        This page is requesting {chooser.multiple ? "files" : "a file"}.
      </span>
      <Button
        type="button"
        disabled={!enabled || uploading}
        onClick={() => fileInput.current?.click()}
      >
        {uploading ? "Uploading…" : "Choose files"}
      </Button>
      <BrowserIconButton
        type="button"
        aria-label="Cancel file selection"
        disabled={!enabled || uploading}
        onClick={() => {
          void command({
            kind: "upload",
            tabId: chooser.tabId,
            chooserId: chooser.id,
            files: [],
          });
        }}
      >
        <Glyph name="close" />
      </BrowserIconButton>
      <input
        hidden
        ref={fileInput}
        type="file"
        multiple={chooser.multiple}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (!files.length) return;
          if (
            files.length > 20 ||
            files.reduce((size, file) => size + file.size, 0) > 16 * 1024 * 1024
          ) {
            setError("Choose up to 20 files totalling at most 16 MB.");
            return;
          }
          setUploading(true);
          void Promise.all(
            files.map(async (file) => ({
              name: file.name,
              data: await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                  if (typeof reader.result === "string")
                    resolve(reader.result.slice(reader.result.indexOf(",") + 1));
                  else reject(new Error("Could not read file."));
                };
                reader.onerror = () => reject(new Error("Could not read file."));
                reader.readAsDataURL(file);
              }),
            })),
          )
            .then((files) =>
              command({ kind: "upload", tabId: chooser.tabId, chooserId: chooser.id, files }),
            )
            .catch((error: unknown) =>
              setError(error instanceof Error ? error.message : "File upload failed."),
            )
            .finally(() => setUploading(false));
        }}
      />
    </div>
  );
}
export function BrowserDownloads({
  downloads,
  open,
  connected,
  api,
  command,
  setError,
}: {
  downloads: BrowserState["downloads"];
  open: boolean;
  connected: boolean;
  api: BrowserAPI;
  command: Command;
  setError(message: string): void;
}) {
  const [downloading, setDownloading] = useState<string | null>(null);
  if (!open || !downloads.length) return null;
  return (
    <div
      className="browser-download-list max-h-40 shrink-0 overflow-auto border-t border-border px-3 py-1"
      aria-label="Downloads"
    >
      {downloads.map((download) => (
        <div key={download.id} className="flex items-center gap-3 py-[7px]">
          <span className="min-w-0 flex-1 truncate" title={download.name}>
            {download.name}
            <small className="mt-[3px] block text-[10px] text-muted-ink">
              {download.status === "pending"
                ? "Downloading…"
                : download.status === "failed"
                  ? "Download failed or exceeds 16 MB"
                  : `${Math.max(1, Math.round(download.size / 1024))} KB`}
            </small>
          </span>
          <Button
            type="button"
            disabled={download.status !== "ready" || Boolean(downloading) || !connected}
            onClick={() => {
              if (downloading) return;
              setDownloading(download.id);
              void command({ kind: "download", tabId: download.tabId, downloadId: download.id })
                .then((result) => {
                  if (result?.output !== undefined)
                    return api.download(download.name, result.output);
                })
                .catch((error: unknown) =>
                  setError(error instanceof Error ? error.message : "Download failed."),
                )
                .finally(() => setDownloading(null));
            }}
          >
            {downloading === download.id ? "Downloading…" : "Download"}
          </Button>
        </div>
      ))}
    </div>
  );
}
