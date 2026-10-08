import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { TidyDesign } from "@tidy/design-renderer/design";
import { Button } from "@tidy/ui/button";
import { SelectMenu } from "@tidy/ui/select-menu";
import { HostBridge } from "./bridge";
import { acceptPreview, readPreview, type DesignPreview } from "./contract";

export function App() {
  const [preview, setPreview] = useState<DesignPreview | null>(null);
  const [selected, setSelected] = useState<{ fileId: string; rootId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const bridge = useRef<HostBridge | null>(null);
  const current = useRef(preview);
  current.current = preview;
  const fontKey = JSON.stringify(preview?.fontUrls ?? []);

  useEffect(() => {
    const host = new HostBridge();
    bridge.current = host;
    host.onResult = (result) => {
      if (result.isError) {
        setError(
          result.content?.find((item) => item.type === "text")?.text ??
            "Could not load the design.",
        );
        return;
      }
      const next = readPreview(result);
      if (next) {
        setPreview((previous) => acceptPreview(previous, next));
        setError(null);
      }
    };
    host.onError = (error) => setError(error.message);
    host.onContext = (context) => {
      if (context.theme) document.documentElement.dataset.theme = context.theme;
      if (context.locale) document.documentElement.lang = context.locale;
    };
    void host.connect().catch((error: Error) => setError(error.message));
    const observer = new ResizeObserver(() => host.resize(document.documentElement.scrollHeight));
    observer.observe(document.body);
    return () => {
      observer.disconnect();
      host.dispose();
      bridge.current = null;
    };
  }, []);
  useEffect(() => {
    const links = (JSON.parse(fontKey) as string[]).map((href) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      document.head.append(link);
      return link;
    });
    return () => links.forEach((link) => link.remove());
  }, [fontKey]);

  const rootId =
    selected?.fileId === preview?.fileId &&
    preview?.roots.some((root) => root.id === selected?.rootId)
      ? selected?.rootId
      : preview?.selectedRootId;
  const root = preview?.roots.find((root) => root.id === rootId);
  async function refresh() {
    if (!preview || refreshing) return;
    const fileId = preview.fileId;
    setRefreshing(true);
    setError(null);
    try {
      const result = await bridge.current!.callTool("preview_design", {
        file_id: fileId,
        ...(rootId ? { root_id: rootId } : {}),
      });
      if (result.isError)
        throw new Error(
          result.content?.find((item) => item.type === "text")?.text ??
            "Could not refresh the design.",
        );
      const next = readPreview(result);
      if (!next) throw new Error("The preview response could not be read.");
      setPreview((previous) => acceptPreview(previous, next, fileId));
    } catch (error) {
      if (current.current?.fileId === fileId) setError((error as Error).message);
    } finally {
      setRefreshing(false);
    }
  }
  function choose(id: string) {
    if (preview) setSelected({ fileId: preview.fileId, rootId: id });
    if (preview)
      void bridge.current
        ?.select(preview.fileId, id, preview.revision)
        .catch((error: Error) => setError(error.message));
  }
  return (
    <main className="plugin">
      {preview && (
        <div className="toolbar">
          <span className="file-name" title={preview.name}>
            {preview.name}
          </span>
          {preview.roots.length > 1 && (
            <SelectMenu
              label="Frame"
              value={rootId ?? ""}
              options={preview.roots.map((root) => ({ value: root.id, label: root.name }))}
              onChange={choose}
            />
          )}
          <Button
            variant="text"
            className="action"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
          <Button
            variant="text"
            className="action"
            onClick={() => {
              if (preview)
                void bridge.current
                  ?.openLink(preview.url)
                  .catch((error: Error) => setError(error.message));
            }}
          >
            Open in Tidy ↗
          </Button>
        </div>
      )}
      {error && (
        <p className="message" role="alert">
          {error}
        </p>
      )}
      {!preview && !error && (
        <p className="message" role="status">
          Loading design…
        </p>
      )}
      {preview && !root && <p className="message">This file has no visible layers.</p>}
      {preview && root && (
        <PreviewCanvas key={`${preview.fileId}/${root.id}`} preview={preview} root={root} />
      )}
    </main>
  );
}

function PreviewCanvas({
  preview,
  root,
}: {
  preview: DesignPreview;
  root: DesignPreview["roots"][number];
}) {
  const canvas = useRef<HTMLDivElement>(null),
    design = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const node = preview.document.nodes.find((node) => node.id === root.id)!;
  const [size, setSize] = useState({
    width: node.widthMode === "hug" ? 360 : root.width,
    height: root.height,
  });
  const scale = Math.min(1, Math.max(1, width - 48) / Math.max(1, size.width));
  useLayoutEffect(() => {
    const container = canvas.current,
      element = design.current?.firstElementChild;
    if (!container || !element) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.target === container) setWidth(entry.contentRect.width);
        else {
          const box = entry.borderBoxSize[0];
          const measured = {
            width: box?.inlineSize ?? entry.contentRect.width,
            height: box?.blockSize ?? entry.contentRect.height,
          };
          setSize((previous) =>
            previous.width === measured.width && previous.height === measured.height
              ? previous
              : measured,
          );
        }
      }
    });
    observer.observe(container);
    observer.observe(element);
    return () => observer.disconnect();
  }, [root.id]);
  return (
    <div className="canvas" ref={canvas}>
      <div
        className="scaled"
        style={{
          width: Math.max(1, size.width) * scale,
          minHeight: Math.max(1, size.height) * scale,
        }}
      >
        <div
          className="design"
          ref={design}
          onClickCapture={(event) => event.preventDefault()}
          style={{
            transform: `scale(${scale})`,
            width: node.widthMode === "hug" ? "max-content" : root.width,
            ...(node.heightMode === "fixed" ? { height: root.height } : {}),
          }}
        >
          <TidyDesign
            document={preview.document}
            rootId={root.id}
            assets={preview.assets}
            frameWidth={node.widthMode === "hug" ? size.width : root.width}
          />
        </div>
      </div>
    </div>
  );
}

const container = document.getElementById("root");
if (container) createRoot(container).render(<App />);
