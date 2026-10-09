"use client";
import {
  buildNativeShape,
  isShapeKind,
  shapeKinds,
  type NativeShape,
} from "@bella/design/native-shapes";
import { DesignImage } from "@/components/design/design-image";
import type { TextContent } from "@bella/design/rich-text";
import { AssetBrowser, type BrowserAsset } from "./asset-browser";
import { imageViewport } from "@/lib/design/image-viewport";
import {
  placeAssets,
  replaceImageAsset,
  readImageFile,
  validatePlacementTarget,
  type PlacementAsset,
  type PlacementTarget,
} from "@/lib/design/asset-placement";
import type { ExportRequest } from "@/lib/design/export-plan";
import { FileVersionControl } from "./file-version-control";
import type { RoomCommit } from "@/lib/design/room-edit-queue";
import { PrototypePlayer } from "@/components/design/prototype-player";
import { PrototypeInspector } from "./prototype-inspector";

import type { DesignNodeChanges } from "@/lib/design/document";

import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { NavigationLink as Link } from "@/components/ui/navigation-link";
import { flushSync } from "react-dom";
import { Icon } from "@/components/ui/icon";
import { ComponentLibraryPanel } from "./component-library-panel";
import { SelectMenu } from "@/components/ui/select-menu";
import { PanelToggle } from "./panel-toggle";
import { EditorChrome, EditorPanel } from "./editor-panel";
import { CanvasViewMenu, type CanvasPreferences } from "./canvas-view-menu";
import { EditorHeader, type EditorUser } from "./editor-header";
import dynamic from "next/dynamic";
const EditorReviewControl = dynamic(() =>
  import("./editor-review-control").then((module) => module.EditorReviewControl),
);
const EditorThumbnail = dynamic(
  () => import("../editor-thumbnail").then((module) => module.EditorThumbnail),
  { ssr: false },
);
import type { Review } from "@/lib/github/reviews";
import { CanvasComments, type CanvasCommentsHandle } from "./canvas-comments";
import { LayerContextMenu, layerMenuPosition, type LayerMenuItem } from "./layer-context-menu";
import { renameDesignFile } from "../actions";
import { useFileRoom } from "./use-file-room";
import { CollaboratorOverlay } from "./collaborator-overlay";
import {
  ThreadsWorkspace,
  type ThreadsWorkspaceProps,
} from "@/components/agents/threads-workspace";
import { AgentCursors } from "./agent-cursors";
import { AgentActivityOverlay } from "./agent-activity-overlay";
import { CollaboratorAvatars } from "./collaborator-avatars";
import { diffDocument, type DocumentPatch } from "@/lib/design/document-patch";
import { equalJsonValues } from "@/lib/design/json-value";
import {
  buildDrawnNode,
  nodePageId,
  type DesignDocument,
  type DesignNode,
} from "@/lib/design/document";
import {
  deletePage,
  documentPages,
  duplicatePage,
  nextPageName,
  pageNodes,
} from "@/lib/design/pages";
import {
  absoluteNodePosition,
  canvasWorldPoint,
  containingDrawParent,
} from "@/lib/design/draw-placement";
import { gestureZoomFactor, wheelZoomFactor } from "@/lib/design/canvas-zoom";
import {
  clipboardAssetIds,
  remapClipboardAssets,
  copyLayers,
  copyProperties,
  pasteLayers,
  pasteProperties,
  readDesignClipboard,
  type DesignClipboard,
} from "@/lib/design/clipboard";
import {
  changedLayers,
  movedLayers,
  movableSelectionRoots,
  duplicateLayers,
  editLayers,
  isLayerLocked,
  previewMoveLayers,
  previewLayerChanges,
  selectionRoots,
  trackDocumentChanges,
} from "@/lib/design/edit-document";
import { EditHistory } from "@/lib/design/edit-history";
import { useDocumentFonts } from "@/lib/design/fonts/use-document-fonts";
import { nodePaints, paintStyle } from "@/lib/design/paints";
import {
  initialImageCrop,
  loadedImageSize,
  panImageCrop,
  zoomImageCrop,
  type ImageCrop,
} from "@/lib/design/image-crop";
import { ColorTokens } from "./color-tokens";
import { resolvedColorTokens, resolvedDocumentNodes } from "@/lib/design/design-tokens";
import { useEditorEvent } from "./use-editor-event";
import { useFrameEvent } from "./use-frame-event";
import { useEditorPerformance } from "./use-editor-performance";
import { useVisibleArtboards } from "./use-visible-artboards";
import { CanvasArtwork } from "./canvas-artwork";
import {
  attachCanvasElements,
  canvasElements,
  selectedElements,
  selectionContainsPoint,
} from "./canvas-elements";
import { selectionDragTarget } from "@/lib/design/selection-drag-target";
import { LayerTree } from "./layer-tree";
import { SendFeedback } from "@/components/workspace/send-feedback";
import { FontRecovery } from "./font-recovery";
import { ImportNotes } from "./import-notes";
import { setImportNoteStatus } from "@/lib/design/import-notes";
import { VectorEditor } from "./vector-editor";
import { PenEditor } from "./pen-editor";
import {
  parsePathContours,
  serializeContours,
  type VectorContour,
} from "@bella/design/vector-geometry";
import { SelectionInspector } from "./selection-inspector";
import { storedConstraintBox } from "@/lib/design/constraints";
import { renderedNodeBox, renderedParentSize } from "@/lib/design/canvas-geometry";
import { GradientHandles } from "./gradient-handles";
import { editGradientDocument, previewGradientDocument } from "@/lib/design/gradient-edit";
import type { GradientEdit, Size } from "@/lib/design/gradient-geometry";
import { SelectionHandles } from "./selection-handles";
import { MultiSelectionHandles } from "./multi-selection-handles";
import { CanvasGuides } from "./canvas-guides";
import { addGuide, moveGuide, removeGuide } from "@/lib/design/guides";
import { resizeBox, type ResizeHandle } from "@/lib/design/resize-box";
import { prepareSnapIndex } from "@/lib/design/snap-index";
import {
  boundingBox,
  equalSpacingCues,
  snapResize,
  snapTranslation,
  type SnapBox,
  type SnapGuide,
  type SpacingCue,
} from "@/lib/design/snapping";
import {
  fitContents,
  resizeSelectedLayers,
  scaleLayers,
  unwrapLayer,
  wrapLayers,
  type WrapKind,
} from "@/lib/design/layout-operations";
import {
  alignLayers,
  createComponentInstance,
  distributeLayers,
  makeComponent,
  moveLayer,
  relocateLayer,
  removeLayers,
} from "@/lib/design/document-operations";

type Snapshot = { revision: number; content: DesignDocument };
type View = { zoom: number; x: number; y: number };
type NodeChanges = DesignNodeChanges;
type CanvasTool =
  | "select"
  | "hand"
  | "frame"
  | "rectangle"
  | "text"
  | "comment"
  | "pen"
  | NativeShape["kind"];
type Point = { x: number; y: number };
type Drawing = {
  start: Point;
  end: Point;
  type: "artboard" | "container";
  shape?: NativeShape["kind"];
  parentId: string | null;
};
type Marquee = { start: Point; end: Point; additive: string[] };

function drawingBox(start: Point, end: Point) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function CanvasToolButton({
  label,
  hint,
  pressed,
  onClick,
  children,
}: {
  label: string;
  hint: string;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const tipId = `canvas-tip-${label.toLowerCase().replaceAll(" ", "-")}`;
  return (
    <button
      type="button"
      aria-label={label}
      aria-describedby={tipId}
      aria-pressed={pressed}
      onClick={onClick}
      className={`group relative flex h-10 w-10 items-center justify-center rounded-lg focus-visible:outline-2 focus-visible:outline-primary-orange active:scale-[0.97] ${pressed ? "bg-strong-action text-on-strong-action" : "text-primary-black/75 hover:bg-primary-grey/20"}`}
    >
      {children}
      <span
        id={tipId}
        role="tooltip"
        className="pointer-events-none absolute left-[calc(100%+0.75rem)] top-1/2 z-30 -translate-y-1/2 whitespace-nowrap rounded-lg bg-strong-action px-2 py-1 text-xs text-on-strong-action opacity-0 shadow-sm transition-opacity duration-150 delay-300 group-hover:opacity-100 group-focus-visible:opacity-100 group-focus-visible:delay-0"
      >
        {hint}
      </span>
    </button>
  );
}

function fit(nodes: DesignNode[], width: number, height: number): View {
  const roots = nodes.filter((node) => node.parentId === null);
  if (!roots.length) return { zoom: 1, x: 0, y: 0 };
  const left = Math.min(...roots.map((node) => node.box.x));
  const top = Math.min(...roots.map((node) => node.box.y));
  const right = Math.max(...roots.map((node) => node.box.x + node.box.width));
  const bottom = Math.max(...roots.map((node) => node.box.y + node.box.height));
  const zoom = Math.min(1, (width - 120) / (right - left), (height - 120) / (bottom - top));
  return {
    zoom,
    x: (width - (right - left) * zoom) / 2 - left * zoom,
    y: (height - (bottom - top) * zoom) / 2 - top * zoom,
  };
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function FileEditor({
  fileId,
  fileName,
  organizationName,
  backHref,
  initialDocument,
  previewAssetUrls,
  preview: previewMode = false,
  archived = false,
  canEdit = true,
  local = false,
  initialPanelsOpen = false,
  user,
  githubReviews,
  viewerId,
  initialReviewId,
  agents: initialAgents,
}: {
  fileId: string;
  fileName: string;
  organizationName: string;
  backHref: string;
  initialDocument: Snapshot;
  previewAssetUrls?: Record<string, string>;
  preview?: boolean;
  archived?: boolean;
  canEdit?: boolean;
  initialPanelsOpen?: boolean;
  user?: EditorUser;
  local?: boolean;
  githubReviews?:
    | Promise<{ ready: boolean; reviews: Omit<Review, "content">[] }>
    | { ready: boolean; reviews: Omit<Review, "content">[] };
  viewerId?: string;
  initialReviewId?: string;
  agents?: ThreadsWorkspaceProps | Promise<ThreadsWorkspaceProps | undefined>;
}) {
  // Archived snapshots use the static viewer: no live room, comments or writes.
  const preview = previewMode || archived;
  const [agents, setAgents] = useState<ThreadsWorkspaceProps | undefined>(() =>
    initialAgents && !("then" in initialAgents) ? initialAgents : undefined,
  );
  useEffect(() => {
    let active = true;
    Promise.resolve(initialAgents)
      .then((next) => {
        if (active) setAgents(next);
      })
      .catch((error) => console.error("Could not load file agents.", error));
    return () => {
      active = false;
    };
  }, [initialAgents]);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [openedThread, setOpenedThread] = useState<{ id: string; version: number }>();
  const threadButton = useRef<HTMLButtonElement>(null);
  const closeThreads = () => {
    setThreadsOpen(false);
    threadButton.current?.focus();
  };
  const [liveCanEdit, setLiveCanEdit] = useState(canEdit);
  const [inspectorMode, setInspectorMode] = useState<"design" | "inspect">("design");
  const permissionReadOnly = preview || !liveCanEdit;
  const readOnly = permissionReadOnly || inspectorMode === "inspect";
  const [name, setName] = useState(fileName);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(fileName);
  const [snapshot, setSnapshotState] = useState(initialDocument);
  const assetMimeTypes = useMemo(
    () => ({ ...initialDocument.content.assetMimeTypes, ...snapshot.content.assetMimeTypes }),
    [initialDocument.content.assetMimeTypes, snapshot.content.assetMimeTypes],
  );
  const [activePageId, setActivePageId] = useState(documentPages(initialDocument.content)[0].id);
  const activePageRef = useRef(activePageId);
  const pageViewsRef = useRef(new Map<string, View>());
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [pageNameDraft, setPageNameDraft] = useState("");
  const [pageMenu, setPageMenu] = useState<{ x: number; y: number; pageId: string } | null>(null);
  const [selection, setSelection] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sidebarTab, setSidebarTab] = useState<"layers" | "tokens">("layers");
  const [layerQuery, setLayerQuery] = useState("");
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const [panelsOpen, setPanelsOpen] = useState(initialPanelsOpen);
  const [inspectorDismissed, setInspectorDismissed] = useState(false);
  const [tool, setTool] = useState<CanvasTool>("select");
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const [drawing, setDrawing] = useState<Drawing | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [snapGuides, setSnapGuides] = useState<SnapGuide[]>([]);
  const [spacingCues, setSpacingCues] = useState<SpacingCue[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [prototypeMode, setPrototypeMode] = useState(false);
  const [interactionMode, setInteractionMode] = useState(false);
  const [prototypeArtboardId, setPrototypeArtboardId] = useState<string | null>(null);
  const [viewPreferences, setViewPreferences] = useState<CanvasPreferences>({
    centerSelection: false,
    numberKeys: false,
    invertZoom: false,
    rightClickPan: false,
    pixelGrid: false,
    snapPixels: true,
    snapObjects: true,
    guides: false,
    deepSelection: true,
    comments: true,
  });
  const [nudgeStep, setNudgeStep] = useState(() => {
    if (typeof window === "undefined") return 1;
    try {
      const saved = Number(window.localStorage.getItem("bella-canvas-nudge-step"));
      if (Number.isInteger(saved) && saved >= 1 && saved <= 100) return saved;
    } catch {
      /* Storage can be disabled in private browsing. */
    }
    return 1;
  });
  function updateNudgeStep(step: number) {
    if (!Number.isInteger(step) || step < 1 || step > 100) return;
    setNudgeStep(step);
    try {
      window.localStorage.setItem("bella-canvas-nudge-step", String(step));
    } catch {
      /* Keep this session's value. */
    }
  }
  const [gradientMode, setGradientMode] = useState<{ nodeId: string; paintId: string } | null>(
    null,
  );
  const gradientGesture = useRef<{
    nodeId: string;
    paintId: string;
    edit?: GradientEdit;
    size?: Size;
  } | null>(null);
  const [vectorMode, setVectorMode] = useState<string | null>(null);
  const vectorGesture = useRef<{ nodeId: string; path: string } | null>(null);
  const [cropId, setCropId] = useState<string | null>(null);
  const cropDrag = useRef<{
    id: string;
    x: number;
    y: number;
    inverse: DOMMatrix;
    box: DesignNode["box"];
    crop: ImageCrop;
  } | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    nodeId: string;
    behindIds: string[];
  } | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const viewport = useRef<HTMLDivElement>(null);
  const [elements] = useState(() => new Map<string, HTMLElement>());
  const registerElement = useCallback(
    (id: string, element: HTMLDivElement | null) => {
      if (element) elements.set(id, element);
      else elements.delete(id);
    },
    [elements],
  );
  const attachViewport = useCallback(
    (canvas: HTMLDivElement | null) => {
      viewport.current = canvas;
      if (canvas) attachCanvasElements(canvas, elements);
    },
    [elements],
  );
  const commentsRef = useRef<CanvasCommentsHandle>(null);
  const busyRef = useRef(false);
  const editingRef = useRef(false);
  const cancelNameEditRef = useRef(false);
  const nameSavingRef = useRef(false);
  const nameVersionRef = useRef(0);
  const cancelPageEditRef = useRef(false);
  const inspectorRef = useRef<HTMLElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const uploadInProgress = useRef(false);
  const [browserAssets, setBrowserAssets] = useState<BrowserAsset[]>([]);
  const [assetCursor, setAssetCursor] = useState<string | null>(null);
  const [assetLoading, setAssetLoading] = useState(false);
  const [assetError, setAssetError] = useState("");
  const replaceImageInput = useRef<HTMLInputElement>(null);
  const drag = useRef<{
    pointerId: number;
    id: string;
    x: number;
    y: number;
    ids: string[];
    before: Snapshot;
    bounds: SnapBox | null;
    candidates: SnapBox[];
    parents: Map<string, { width: number; height: number }>;
  } | null>(null);
  const resize = useRef<{ ids: string[] } | null>(null);
  const multiScaleGesture = useRef<{
    ids: string[];
    boxes: Map<string, DesignNode["box"]>;
    candidates: SnapBox[];
  } | null>(null);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const drawingRef = useRef<Drawing | null>(null);
  const marqueeRef = useRef<Marquee | null>(null);
  const [viewportReady, setViewportReady] = useState(false);
  const [history] = useState(() => new EditHistory());
  const selectionKeyHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  const snapshotRef = useRef(snapshot);
  const pendingCountRef = useRef(0);
  function setSnapshot(next: Snapshot | ((current: Snapshot) => Snapshot)) {
    const value = typeof next === "function" ? next(snapshotRef.current) : next;
    snapshotRef.current = value;
    setSnapshotState(value);
  }
  const receiveSnapshot = useCallback((next: Snapshot) => {
    const local = snapshotRef.current;
    const oldNodes = new Map(local.content.nodes.map((node) => [node.id, node]));
    // Preserve only this session's active gesture while accepting all other edits.
    const activeGradient = gradientGesture.current;
    const incoming =
      activeGradient?.edit && activeGradient.size
        ? previewGradientDocument(
            next.content,
            activeGradient.nodeId,
            activeGradient.paintId,
            activeGradient.edit,
            activeGradient.size,
          )
        : next.content;
    const reconciled = incoming.nodes.map((node) => {
      const old = oldNodes.get(node.id);
      if (!old) return node;
      if (drag.current?.ids.includes(node.id))
        return { ...node, box: { ...node.box, x: old.box.x, y: old.box.y } };
      if (resize.current?.ids.includes(node.id)) return old;
      if (
        vectorGesture.current &&
        vectorGesture.current.nodeId === node.id &&
        JSON.stringify(node.vectorPath) === vectorGesture.current.path
      )
        return { ...node, vectorPath: old.vectorPath };
      if (cropDrag.current?.id === node.id)
        return { ...node, style: { ...node.style, imageCrop: old.style.imageCrop } };
      return equalJsonValues(old, node) ? old : node;
    });
    const content = {
      ...incoming,
      nodes:
        reconciled.length === local.content.nodes.length &&
        reconciled.every((node, index) => node === local.content.nodes[index])
          ? local.content.nodes
          : reconciled,
      tokens: equalJsonValues(local.content.tokens, incoming.tokens)
        ? local.content.tokens
        : incoming.tokens,
    };
    snapshotRef.current = { ...next, content };
    setSnapshotState(snapshotRef.current);
  }, []);
  const receiveName = useCallback((next: string) => {
    if (!nameSavingRef.current) setName(next);
  }, []);
  const receivePermission = useCallback(
    (allowed: boolean) => {
      setLiveCanEdit(allowed);
      if (!allowed) {
        drag.current = null;
        resize.current = null;
        cropDrag.current = null;
        gradientGesture.current = null;
        vectorGesture.current = null;
        setVectorMode(null);
        drawingRef.current = null;
        editingRef.current = false;
        setEditingTextId(null);
        setEditingName(false);
        setEditingPageId(null);
        setContextMenu(null);
        setPageMenu(null);
        setDrawing(null);
        setCropId(null);
        setGradientMode(null);
        setTool((current) =>
          ["select", "hand", "comment"].includes(current) ? current : "select",
        );
      }
    },
    [setPageMenu, setDrawing, setGradientMode, setTool, setVectorMode],
  );
  const room = useFileRoom({
    fileId,
    enabled: !preview && !local,
    initialSnapshot: initialDocument,
    onSnapshot: receiveSnapshot,
    onName: receiveName,
    onPermission: receivePermission,
    local,
  });
  const { restore: restoreSharedSnapshot } = room;
  const pages = useMemo(() => documentPages(snapshot.content), [snapshot.content]);
  const currentPageId = pages.some((page) => page.id === activePageId) ? activePageId : pages[0].id;
  const selectionVersion = useRef(0);
  useLayoutEffect(() => {
    selectionVersion.current++;
  }, [selectedIds, currentPageId]);
  const nodes = useMemo(
    () => snapshot.content.nodes.filter((node) => nodePageId(node) === currentPageId),
    [snapshot.content.nodes, currentPageId],
  );
  const renderedNodes = useMemo(
    () =>
      resolvedDocumentNodes({
        nodes: snapshot.content.nodes,
        tokens: snapshot.content.tokens,
        designTokens: snapshot.content.designTokens,
      }).filter((node) => nodePageId(node) === currentPageId),
    [snapshot.content.nodes, snapshot.content.tokens, snapshot.content.designTokens, currentPageId],
  );
  const renderedById = useMemo(
    () => new Map(renderedNodes.map((node) => [node.id, node])),
    [renderedNodes],
  );
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const inspectorSelection = useMemo(
    () =>
      renderedNodes.filter(
        (node) => selectedIds.includes(node.id) && (readOnly || !isLayerLocked(nodes, node.id)),
      ),
    [renderedNodes, nodes, selectedIds, readOnly],
  );
  useEditorPerformance(viewport, nodes.length, panelsOpen, selectedIds.length > 0);
  const visibleRootIds = useVisibleArtboards(
    renderedNodes,
    view,
    viewport,
    selectedIds,
    room.store,
  );
  useDocumentFonts(renderedNodes, visibleRootIds);
  const selected = nodesById.get(selection ?? "") ?? null;
  const multiScaleIds = useMemo(
    () =>
      selectedIds.length > 1 &&
      selectedIds.every((id) => nodesById.get(id)?.visible && !isLayerLocked(nodes, id))
        ? selectionRoots(nodes, selectedIds).map((node) => node.id)
        : [],
    [nodes, nodesById, selectedIds],
  );
  const multiScaleParent =
    multiScaleIds.length > 1
      ? nodes.find((node) => node.id === multiScaleIds[0])?.parentId
      : undefined;
  const canScaleSelection =
    multiScaleIds.length > 1 &&
    multiScaleIds.every(
      (id) => nodes.find((node) => node.id === id)?.parentId === multiScaleParent,
    );
  const inspectorOpen =
    !prototypeMode &&
    selected !== null &&
    inspectorSelection.length > 0 &&
    (panelsOpen || !inspectorDismissed);
  const cropping = Boolean(
    cropId &&
    selected?.id === cropId &&
    selectedIds.length === 1 &&
    selected.style.imageCrop &&
    !readOnly &&
    !prototypeMode &&
    tool === "select" &&
    !isLayerLocked(nodes, cropId),
  );
  if (cropId && !cropping) setCropId(null);
  useEffect(() => {
    if (!cropping) cropDrag.current = null;
  }, [cropping]);
  const gradientPaint =
    selected && gradientMode?.nodeId === selected.id
      ? nodePaints(selected).find((paint) => paint.id === gradientMode.paintId)
      : undefined;
  const editingGradient = Boolean(
    gradientPaint?.visible &&
    (gradientPaint.type === "linear" || gradientPaint.type === "radial") &&
    selectedIds.length === 1 &&
    selected?.visible &&
    !readOnly &&
    !prototypeMode &&
    tool === "select" &&
    !isLayerLocked(nodes, selected!.id) &&
    !editingTextId,
  );
  if (gradientMode && !editingGradient) setGradientMode(null);
  const artboards = useMemo(
    () => snapshot.content.nodes.filter((node) => node.type === "artboard" && node.visible),
    [snapshot.content.nodes],
  );

  const { publishPresence } = room;
  useEffect(() => {
    publishPresence({ pageId: currentPageId, cursor: null, preview: null }, true);
  }, [currentPageId, publishPresence]);
  useEffect(() => {
    publishPresence({ selectedIds }, true);
  }, [selectedIds, publishPresence]);
  useEffect(() => {
    publishPresence(
      { action: editingTextId ? "typing" : isShapeKind(tool) ? "rectangle" : tool },
      true,
    );
  }, [tool, editingTextId, publishPresence]);

  function toggleViewPreference(key: keyof CanvasPreferences) {
    setViewPreferences((current) => ({ ...current, [key]: !current[key] }));
  }

  function selectedBounds() {
    const canvas = viewport.current;
    if (!canvas) return null;
    const origin = canvas.getBoundingClientRect();
    const boxes = selectedElements(canvas, selectedIds).map((element) =>
      element.getBoundingClientRect(),
    );
    if (!boxes.length) return null;
    const left = Math.min(...boxes.map((box) => box.left));
    const top = Math.min(...boxes.map((box) => box.top));
    return {
      x: (left - origin.left - view.x) / view.zoom,
      y: (top - origin.top - view.y) / view.zoom,
      width: (Math.max(...boxes.map((box) => box.right)) - left) / view.zoom,
      height: (Math.max(...boxes.map((box) => box.bottom)) - top) / view.zoom,
    };
  }

  function zoomView(action: "in" | "out" | "actual" | "fit" | "selection" | number) {
    const canvas = viewport.current;
    if (!canvas) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (action === "fit") {
      setView(fit(nodes, width, height));
      return;
    }
    const bounds =
      action === "selection" || viewPreferences.centerSelection ? selectedBounds() : null;
    if (action === "selection" && !bounds) return;
    const zoom = Math.max(
      0.1,
      Math.min(
        3,
        typeof action === "number"
          ? action
          : action === "actual"
            ? 1
            : action === "selection" && bounds
              ? Math.min(
                  (width - 80) / Math.max(1, bounds.width),
                  (height - 80) / Math.max(1, bounds.height),
                )
              : view.zoom * (action === "in" ? 1.25 : 0.8),
      ),
    );
    const center = bounds
      ? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
      : { x: (width / 2 - view.x) / view.zoom, y: (height / 2 - view.y) / view.zoom };
    setView({ zoom, x: width / 2 - center.x * zoom, y: height / 2 - center.y * zoom });
  }

  function snapCoordinate(value: number) {
    return viewPreferences.snapPixels ? Math.round(value) : value;
  }

  function showPrototypeArtboard(id: string) {
    const artboard = artboards.find((node) => node.id === id);
    if (!artboard) return;
    setPrototypeArtboardId(id);
  }

  function togglePrototype() {
    if (prototypeMode) {
      setPrototypeMode(false);
      setPrototypeArtboardId(null);
    } else if (artboards.length) {
      setPrototypeMode(true);
      let frame = selected;
      while (frame && frame.type !== "artboard")
        frame = nodes.find((node) => node.id === frame?.parentId) ?? null;
      showPrototypeArtboard(frame?.id ?? artboards[0].id);
    }
  }
  function placeComment(clientX: number, clientY: number) {
    if (preview || local || !viewport.current) return;
    setViewPreferences((current) => ({ ...current, comments: true }));
    const rect = viewport.current.getBoundingClientRect();
    commentsRef.current?.place(
      Math.max(-100000, Math.min(100000, Math.round((clientX - rect.left - view.x) / view.zoom))),
      Math.max(-100000, Math.min(100000, Math.round((clientY - rect.top - view.y) / view.zoom))),
    );
  }
  const children = useMemo(() => {
    const map = new Map<string | null, DesignNode[]>();
    for (const node of renderedNodes) {
      const siblings = map.get(node.parentId);
      if (siblings) siblings.push(node);
      else map.set(node.parentId, [node]);
    }
    return map;
  }, [renderedNodes]);
  const tokens = useMemo(
    () =>
      resolvedColorTokens({
        tokens: snapshot.content.tokens,
        designTokens: snapshot.content.designTokens,
      }),
    [snapshot.content.tokens, snapshot.content.designTokens],
  );

  function togglePanels() {
    editingRef.current = false;
    setInspectorDismissed(true);
    setPanelsOpen((open) => !open);
  }

  function selectNode(id: string, additive = false) {
    const next = additive
      ? selectedIds.includes(id)
        ? selectedIds.filter((item) => item !== id)
        : [...selectedIds, id]
      : [id];
    setSelection(next.at(-1) ?? null);
    setSelectedIds(next);
    setInspectorDismissed(false);
  }

  function switchPage(pageId: string) {
    if (pageId === activePageRef.current) return;
    pageViewsRef.current.set(currentPageId, view);
    activePageRef.current = pageId;
    setActivePageId(pageId);
    setLayerQuery("");
    setSelection(null);
    setSelectedIds([]);
    setContextMenu(null);
    setPageMenu(null);
    setEditingTextId(null);
    editingRef.current = false;
    setPrototypeMode(false);
    setPrototypeArtboardId(null);
    setTool("select");
    if (viewport.current)
      setView(
        pageViewsRef.current.get(pageId) ??
          fit(
            pageNodes(snapshotRef.current.content, pageId),
            viewport.current.clientWidth,
            viewport.current.clientHeight,
          ),
      );
  }

  async function createPage() {
    if (readOnly) return;
    const id = crypto.randomUUID();
    const name = nextPageName(snapshotRef.current.content);
    const previousPageId = currentPageId;
    switchPage(id);
    await changeDocument(
      (content) => ({ ...content, pages: [...documentPages(content), { id, name }] }),
      null,
    );
    if (documentPages(snapshotRef.current.content).some((page) => page.id === id)) {
      if (activePageRef.current === id) {
        setPageNameDraft(name);
        setEditingPageId(id);
      }
    } else if (activePageRef.current === id) switchPage(previousPageId);
  }

  function renamePage(pageId: string, draft: string) {
    setEditingPageId(null);
    if (cancelPageEditRef.current) {
      cancelPageEditRef.current = false;
      return;
    }
    const name = draft.trim();
    if (!name || name.length > 120) {
      setError("Enter a page name of up to 120 characters.");
      return;
    }
    if (pages.find((page) => page.id === pageId)?.name === name) return;
    void changeDocument((content) => ({
      ...content,
      pages: documentPages(content).map((page) => (page.id === pageId ? { ...page, name } : page)),
    }));
  }

  async function copyPage(pageId: string) {
    const id = crypto.randomUUID();
    const previousPageId = currentPageId;
    switchPage(id);
    if (viewport.current)
      setView(
        pageId === currentPageId
          ? view
          : (pageViewsRef.current.get(pageId) ??
              fit(
                pageNodes(snapshotRef.current.content, pageId),
                viewport.current.clientWidth,
                viewport.current.clientHeight,
              )),
      );
    await changeDocument(
      (content) => duplicatePage(content, pageId, id, () => crypto.randomUUID()),
      null,
    );
    if (
      !documentPages(snapshotRef.current.content).some((page) => page.id === id) &&
      activePageRef.current === id
    )
      switchPage(previousPageId);
  }

  async function removePage(pageId: string) {
    if (pages.length === 1) return;
    const nextId = pages.find((page) => page.id !== pageId)!.id;
    if (currentPageId === pageId) switchPage(nextId);
    await changeDocument((content) => deletePage(content, pageId), null);
    if (
      documentPages(snapshotRef.current.content).some((page) => page.id === pageId) &&
      currentPageId === pageId
    )
      switchPage(pageId);
  }

  function movePage(pageId: string, direction: -1 | 1) {
    void changeDocument((content) => {
      const pages = [...documentPages(content)];
      const index = pages.findIndex((page) => page.id === pageId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= pages.length) return content;
      [pages[index], pages[target]] = [pages[target], pages[index]];
      return { ...content, pages };
    });
  }

  async function changeDocument(
    transform: (content: DesignDocument) => DesignDocument,
    nextSelection?: string | null | string[],
    base?: Snapshot,
    sourceNodeId?: string,
  ) {
    if (readOnly) return;
    const before = base ?? room.getSnapshot();
    const beforeSelection = selection;
    const completingPreview = room.getPreview();
    let patch: DocumentPatch;
    try {
      // Validate the completed transaction once, including prepared inspector/gesture edits.
      const content = trackDocumentChanges(before.content, transform(before.content));
      patch = diffDocument(before.content, content);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change layers.");
      return;
    }
    if (!patch.length) return;
    pendingCountRef.current++;
    busyRef.current = true;
    setBusy(true);
    setError("");
    // Selection changes belong to the initiating interaction, not its later ack.
    if (nextSelection !== undefined) {
      const ids = Array.isArray(nextSelection)
        ? nextSelection
        : nextSelection
          ? [nextSelection]
          : [];
      setSelectedIds(ids);
      setSelection(ids.at(-1) ?? null);
      setInspectorDismissed(false);
    }
    try {
      const committed = room.commit(patch, false, sourceNodeId);
      history.record(patch, committed, {
        selection: beforeSelection,
        selectedIds,
        pageId: currentPageId,
      });
      await committed;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change layers.");
    } finally {
      pendingCountRef.current--;
      busyRef.current = pendingCountRef.current > 0;
      setBusy(busyRef.current);
      room.clearPreview(completingPreview);
    }
  }

  const assetRequests = useRef({ version: 0 });
  const loadAssets = useEditorEvent(async (cursor?: string | null) => {
    if (local || preview) return;
    const version = ++assetRequests.current.version;
    setAssetLoading(true);
    try {
      const response = await fetch(
        `/api/files/${encodeURIComponent(fileId)}/assets${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      const result: { assets: BrowserAsset[]; nextCursor: string | null; error?: string } =
        await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not load assets.");
      if (version !== assetRequests.current.version) return;
      setBrowserAssets((before) => [
        ...new Map(
          [...(cursor ? before : []), ...result.assets].map((asset: BrowserAsset) => [
            asset.assetId,
            asset,
          ]),
        ).values(),
      ]);
      setAssetCursor(result.nextCursor);
      setAssetError("");
    } catch (cause) {
      if (version !== assetRequests.current.version) return;
      setAssetError(cause instanceof Error ? cause.message : "Could not load assets.");
    } finally {
      if (version === assetRequests.current.version) setAssetLoading(false);
    }
  });
  useEffect(() => {
    const requests = assetRequests.current;
    void loadAssets();
    return () => {
      requests.version++;
    };
  }, [fileId, local, preview, loadAssets]);

  function placementTarget(): PlacementTarget {
    const parentId =
      selected && ["artboard", "container"].includes(selected.type)
        ? selected.id
        : (selected?.parentId ?? null);
    const rect = viewport.current?.getBoundingClientRect();
    const point = rect
      ? worldPoint({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 })
      : { x: 120, y: 120 };
    return {
      parentId,
      pageId: currentPageId,
      x: parentId ? 20 : point.x,
      y: parentId ? 20 : point.y,
    };
  }
  const completeAssets = useEditorEvent(
    async (
      assets: PlacementAsset[],
      target: PlacementTarget,
      version: number,
      replacement?: { id: string; assetId?: string },
    ) => {
      if (readOnly) return;
      const ids = assets.map(() => crypto.randomUUID());
      await changeDocument(
        (content) =>
          replacement
            ? replaceImageAsset(content, replacement.id, replacement.assetId, assets[0])
            : placeAssets(content, target, assets, ids),
        selectionVersion.current === version ? (replacement?.id ?? ids) : undefined,
      );
      void loadAssets();
    },
  );
  async function uploadImages(files: File[], replaceId?: string, target = placementTarget()) {
    if (readOnly || local || uploadInProgress.current || !files.length) return;
    if (files.length > 50) {
      setError("Place at most 50 images at a time.");
      return;
    }
    const replacement = replaceId
      ? snapshotRef.current.content.nodes.find((node) => node.id === replaceId)
      : undefined;
    const captured = replacement ? { id: replacement.id, assetId: replacement.assetId } : undefined;
    if (replaceId && !captured) {
      setError("The replacement layer was removed.");
      return;
    }
    try {
      if (!captured) validatePlacementTarget(room.getSnapshot().content, target);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invalid destination.");
      return;
    }
    const version = selectionVersion.current;
    uploadInProgress.current = true;
    setUploading(true);
    setError("");
    const assets: PlacementAsset[] = [],
      failures: string[] = [];
    try {
      for (const file of files) {
        try {
          const decoded = await readImageFile(file),
            form = new FormData();
          form.set("image", file);
          const response = await fetch(`/api/files/${encodeURIComponent(fileId)}/assets`, {
            method: "POST",
            body: form,
          });
          const result: { assetId?: string; error?: string } = await response.json();
          if (!response.ok || !result.assetId)
            throw new Error(result.error ?? "Could not upload image.");
          if (decoded.reason) failures.push(`${file.name || "Image"}: ${decoded.reason}`);
          assets.push({
            id: result.assetId,
            name: file.name || "Image",
            mimeType: file.type,
            ...decoded,
          });
        } catch (cause) {
          failures.push(
            `${file.name || "Image"}: ${cause instanceof Error ? cause.message : "Could not upload image."}`,
          );
        }
      }
      if (assets.length) await completeAssets(assets, target, version, captured);
      if (failures.length) setError(failures.join(" "));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not place images.");
    } finally {
      uploadInProgress.current = false;
      setUploading(false);
    }
  }
  async function placeBrowserAsset(asset: BrowserAsset) {
    if (readOnly || uploadInProgress.current) return;
    const version = selectionVersion.current,
      target = placementTarget();
    uploadInProgress.current = true;
    setUploading(true);
    try {
      const response = await fetch(`/api/assets/${asset.assetId}`);
      if (!response.ok) throw new Error("This asset is unavailable.");
      const blob = await response.blob(),
        file = new File([blob], "Image", { type: asset.mimeType });
      const decoded = await readImageFile(file);
      await completeAssets(
        [{ id: asset.assetId, name: "Image", mimeType: asset.mimeType, ...decoded }],
        target,
        version,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not place asset.");
    } finally {
      uploadInProgress.current = false;
      setUploading(false);
    }
  }
  function dropImages(event: React.DragEvent<HTMLDivElement>) {
    if (readOnly || !event.dataTransfer.files.length) return;
    event.preventDefault();
    event.stopPropagation();
    const element = (event.target as Element).closest<HTMLElement>("[data-node-id]");
    const node = nodes.find((node) => node.id === element?.dataset.nodeId);
    const parentId =
      node && ["artboard", "container"].includes(node.type) ? node.id : (node?.parentId ?? null);
    const parent = parentId ? canvasElements(viewport.current).get(parentId) : undefined;
    let point = worldPoint(event);
    if (parent) {
      let matrix = new DOMMatrix();
      for (
        let element: HTMLElement | null = parent;
        element && element !== viewport.current;
        element = element.parentElement
      ) {
        const transform = getComputedStyle(element).transform;
        if (transform !== "none") matrix = new DOMMatrix(transform).multiply(matrix);
      }
      const inverse = matrix.inverse(),
        rect = parent.getBoundingClientRect(),
        style = getComputedStyle(parent);
      const dx = event.clientX - (rect.left + rect.width / 2),
        dy = event.clientY - (rect.top + rect.height / 2);
      point = {
        x:
          parseFloat(style.width) / 2 +
          inverse.a * dx +
          inverse.c * dy -
          parseFloat(style.borderLeftWidth),
        y:
          parseFloat(style.height) / 2 +
          inverse.b * dx +
          inverse.d * dy -
          parseFloat(style.borderTopWidth),
      };
    }
    void uploadImages(Array.from(event.dataTransfer.files), undefined, {
      pageId: currentPageId,
      parentId,
      ...point,
    });
  }

  async function uploadFillImage(index: number, file: File) {
    if (readOnly || file.size > 2_000_000) {
      setError("Choose an image under 2 MB.");
      return;
    }
    const targets = selectedIds
      .map((id) => {
        const node = snapshotRef.current.content.nodes.find((node) => node.id === id);
        const paint = node ? nodePaints(node)[index] : undefined;
        return {
          id,
          paintId: paint?.id,
          assetId: paint?.type === "image" ? paint.assetId : undefined,
        };
      })
      .filter((target) => target.paintId);
    try {
      const form = new FormData();
      form.set("image", file);
      const response = await fetch(`/api/files/${encodeURIComponent(fileId)}/assets`, {
        method: "POST",
        body: form,
      });
      const result: { assetId?: string; error?: string } = await response.json();
      if (!response.ok || !result.assetId)
        throw new Error(result.error ?? "Could not upload fill image.");
      await changeDocument((content) =>
        editLayers(
          {
            ...content,
            assetMimeTypes: { ...content.assetMimeTypes, [result.assetId!]: file.type },
          },
          targets.map((target) => target.id),
          (node) => ({
            style: paintStyle(
              nodePaints(node).map((paint) =>
                paint.id === targets.find((target) => target.id === node.id)?.paintId &&
                paint.type === "image" &&
                paint.assetId === targets.find((target) => target.id === node.id)?.assetId
                  ? { ...paint, assetId: result.assetId, crop: undefined }
                  : paint,
              ),
            ),
          }),
        ),
      );
      void loadAssets();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not upload fill image.");
    }
  }

  const [exportPending, setExportPending] = useState(false);
  const [exportWarnings, setExportWarnings] = useState<string[]>([]);
  const exportRunning = useRef(false);
  async function exportSelection(request: ExportRequest) {
    if (exportRunning.current) return;
    exportRunning.current = true;
    setExportPending(true);
    setExportWarnings([]);
    try {
      const { createSelectionExport } = await import("@/lib/design/export-selection");
      const result = await createSelectionExport(
        snapshotRef.current.content,
        canvasElements(viewport.current),
        request,
      );
      for (const file of result.files) downloadBlob(file.blob, file.name);
      setExportWarnings(result.warnings);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not export selection.");
    } finally {
      exportRunning.current = false;
      setExportPending(false);
    }
  }

  async function finishNameEdit() {
    if (readOnly) return;
    setEditingName(false);
    if (cancelNameEditRef.current) {
      cancelNameEditRef.current = false;
      return;
    }
    const next = nameDraft.trim();
    if (!next || next === name) return;
    const previous = name;
    const version = ++nameVersionRef.current;
    setName(next);
    nameSavingRef.current = true;
    try {
      if (local) {
        setName(next);
        return;
      }
      const result = await renameDesignFile(fileId, next);
      if (result.error) throw new Error(result.error);
    } catch (error) {
      if (version === nameVersionRef.current) {
        setName(previous);
        setError(error instanceof Error ? error.message : "Could not rename the file.");
      }
    } finally {
      if (version === nameVersionRef.current) nameSavingRef.current = false;
    }
  }

  const fileNameEditor = readOnly ? (
    <span className="block max-w-full truncate font-medium">
      {name}
      {archived && (
        <span className="block text-xs font-normal text-secondary-ink">Archived · Read only</span>
      )}
    </span>
  ) : editingName ? (
    <input
      aria-label="File name"
      autoFocus
      maxLength={120}
      value={nameDraft}
      onChange={(event) => setNameDraft(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => void finishNameEdit()}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          cancelNameEditRef.current = true;
          event.currentTarget.blur();
        }
      }}
      className="block w-full min-w-0 bg-transparent font-medium outline-none focus-visible:ring-1 focus-visible:ring-primary-orange"
    />
  ) : (
    <button
      type="button"
      className="block max-w-full truncate text-left font-medium"
      onClick={() => {
        setNameDraft(name);
        setEditingName(true);
      }}
    >
      {name}
    </button>
  );

  async function restoreFileVersion(versionId: string, expectedRevision: number) {
    if (readOnly || local || prototypeMode)
      throw new Error("Editor access is required to restore a version.");
    const capturedSelection = { selection, selectedIds, pageId: currentPageId };
    pendingCountRef.current++;
    busyRef.current = true;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/files/${encodeURIComponent(fileId)}/history/${versionId}/restore`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operationId: crypto.randomUUID(), expectedRevision }),
        },
      );
      const result = (await response.json()) as RoomCommit & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Could not restore this version.");
      if (result.patch.length)
        history.record(result.patch, Promise.resolve(result), capturedSelection);
      room.receive(result.snapshot);
    } finally {
      pendingCountRef.current--;
      busyRef.current = pendingCountRef.current > 0;
      setBusy(busyRef.current);
    }
  }
  const fileHeading = fileNameEditor;

  async function travelHistory(direction: "undo" | "redo") {
    if (readOnly) return;
    if (gradientGesture.current) {
      gradientGesture.current = null;
      setGradientMode(null);
      room.restore();
    }
    const action = history.travel(
      direction,
      { selection, selectedIds, pageId: currentPageId },
      (patch, dependency) => room.commit(patch, true, undefined, dependency),
    );
    if (!action) return;
    pendingCountRef.current++;
    busyRef.current = true;
    setBusy(true);
    setError("");
    const content = room.getSnapshot().content;
    const target = action.selection;
    const nextPageId = documentPages(content).some((page) => page.id === target.pageId)
      ? target.pageId
      : documentPages(content)[0].id;
    activePageRef.current = nextPageId;
    setActivePageId(nextPageId);
    if (nextPageId !== currentPageId && viewport.current)
      setView(
        fit(
          pageNodes(content, nextPageId),
          viewport.current.clientWidth,
          viewport.current.clientHeight,
        ),
      );
    const ids = target.selectedIds.filter((id) => content.nodes.some((node) => node.id === id));
    setSelectedIds(ids);
    setSelection(ids.at(-1) ?? null);
    try {
      await action.committed;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not undo this edit.");
    } finally {
      pendingCountRef.current--;
      busyRef.current = pendingCountRef.current > 0;
      setBusy(busyRef.current);
    }
  }

  useEffect(() => {
    if (readOnly || prototypeMode) return;
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.isComposing ||
        event.repeat ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.key.toLowerCase() !== "z"
      )
        return;
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, [contenteditable]"))
        return;
      event.preventDefault();
      void travelHistory(event.shiftKey ? "redo" : "undo");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (prototypeMode) return;
      if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      const element = target instanceof Element ? target : null;
      if (event.code === "Space") {
        if (element?.closest("button, a, input, textarea, select, [contenteditable]")) return;
        event.preventDefault();
        setSpaceHeld(true);
        return;
      }
      if (element?.closest("input, textarea, select, [contenteditable]")) return;
      if (event.repeat) return;
      if (event.shiftKey) return;
      const shortcut = event.key.toLowerCase();
      if (shortcut === "v") {
        event.preventDefault();
        setTool("select");
      }
      if (shortcut === "h") {
        event.preventDefault();
        setTool("hand");
      }
      if (shortcut === "f" && !readOnly) {
        event.preventDefault();
        setTool("frame");
      }
      if (shortcut === "r" && !readOnly) {
        event.preventDefault();
        setTool("rectangle");
      }
      if (shortcut === "p" && !readOnly) {
        event.preventDefault();
        setVectorMode(null);
        setTool("pen");
      }
      if (shortcut === "t" && !readOnly) {
        event.preventDefault();
        setTool("text");
      }
      if (shortcut === "c" && !preview) {
        event.preventDefault();
        setTool("comment");
      }
      if (event.key === "Escape" && editingGradient) {
        event.preventDefault();
        event.stopImmediatePropagation();
        gradientGesture.current = null;
        restoreSharedSnapshot();
        setGradientMode(null);
        return;
      }
      if (event.key === "Escape" && cropping) {
        event.preventDefault();
        event.stopImmediatePropagation();
        cropDrag.current = null;
        resize.current = null;
        restoreSharedSnapshot();
        setCropId(null);
        return;
      }
      if (event.key === "Escape") {
        cropDrag.current = null;
        drag.current = null;
        resize.current = null;
        drawingRef.current = null;
        restoreSharedSnapshot();
        publishPresence({ preview: null, action: "select" }, true);
        setDrawing(null);
        setTool("select");
      }
    }
    function onKeyUp(event: KeyboardEvent) {
      if (event.code === "Space") setSpaceHeld(false);
    }
    function onBlur() {
      setSpaceHeld(false);
      setPanning(false);
      pan.current = null;
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [
    preview,
    readOnly,
    prototypeMode,
    restoreSharedSnapshot,
    publishPresence,
    cropping,
    editingGradient,
  ]);

  useLayoutEffect(() => {
    const canvas = viewport.current;
    if (viewportReady || !canvas) return;
    // Fit before revealing server-rendered artwork; an effect alone allows a 100% flash.
    function initializeViewport() {
      if (!canvas || canvas.clientWidth <= 0 || canvas.clientHeight <= 0) return;
      setView(
        fit(
          pageNodes(initialDocument.content, currentPageId),
          canvas.clientWidth,
          canvas.clientHeight,
        ),
      );
      setViewportReady(true);
    }
    initializeViewport();
    // A hidden editor can mount before its container has measurable dimensions.
    const observer = new ResizeObserver(initializeViewport);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [initialDocument, currentPageId, viewportReady]);

  useLayoutEffect(() => {
    const canvas = viewport.current;
    if (!canvas || !viewportReady) return;
    let width = canvas.clientWidth;
    let height = canvas.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextWidth = canvas.clientWidth;
      const nextHeight = canvas.clientHeight;
      const dx = (nextWidth - width) / 2;
      const dy = (nextHeight - height) / 2;
      width = nextWidth;
      height = nextHeight;
      // Preserve the current canvas centre throughout panel motion, including reversals.
      if (dx || dy) {
        // ResizeObserver runs before paint; commit now to avoid a stale canvas position
        // being painted against the next panel width for one frame.
        flushSync(() =>
          setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy })),
        );
      }
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [viewportReady]);

  useEffect(() => {
    const canvas = viewport.current;
    if (!canvas) return;
    let lastGestureScale = 1;
    let gestureActive = false;
    let viewFrame: number | undefined;
    let updates: ((current: typeof view) => typeof view)[] = [];
    function scheduleView(update: (current: typeof view) => typeof view) {
      updates.push(update);
      if (viewFrame !== undefined) return;
      viewFrame = requestAnimationFrame(() => {
        viewFrame = undefined;
        const pending = updates;
        updates = [];
        setView((current) => pending.reduce((value, run) => run(value), current));
      });
    }
    function applyZoom(factor: number, x: number, y: number) {
      let targetX = x;
      let targetY = y;
      if (viewPreferences.centerSelection) {
        const boxes = selectedElements(canvas, selectedIds).map((element) =>
          element.getBoundingClientRect(),
        );
        if (boxes.length) {
          const origin = canvas!.getBoundingClientRect();
          x =
            (Math.min(...boxes.map((box) => box.left)) +
              Math.max(...boxes.map((box) => box.right))) /
              2 -
            origin.left;
          y =
            (Math.min(...boxes.map((box) => box.top)) +
              Math.max(...boxes.map((box) => box.bottom))) /
              2 -
            origin.top;
          targetX = canvas!.clientWidth / 2;
          targetY = canvas!.clientHeight / 2;
        }
      }
      scheduleView((current) => {
        const zoom = Math.max(0.1, Math.min(3, current.zoom * factor));
        return {
          zoom,
          x: targetX - ((x - current.x) * zoom) / current.zoom,
          y: targetY - ((y - current.y) * zoom) / current.zoom,
        };
      });
    }
    function onWheel(event: WheelEvent) {
      if (event.target instanceof Element && event.target.closest("[data-canvas-control], dialog"))
        return;
      event.preventDefault();
      if (gestureActive) return;
      if (!event.ctrlKey) {
        const { deltaX, deltaY } = event;
        scheduleView((current) => ({ ...current, x: current.x - deltaX, y: current.y - deltaY }));
        return;
      }
      const rect = canvas!.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      applyZoom(
        wheelZoomFactor(event.deltaY * (viewPreferences.invertZoom ? -1 : 1), event.ctrlKey),
        x,
        y,
      );
    }
    function onGestureStart(event: Event) {
      if (event.target instanceof Element && event.target.closest("[data-canvas-control], dialog"))
        return;
      event.preventDefault();
      gestureActive = true;
      lastGestureScale = 1;
    }
    function onGestureChange(event: Event) {
      if (event.target instanceof Element && event.target.closest("[data-canvas-control], dialog"))
        return;
      event.preventDefault();
      const gesture = event as Event & { scale?: number; clientX?: number; clientY?: number };
      const scale = gesture.scale ?? 1;
      if (!Number.isFinite(scale) || scale <= 0) return;
      const factor = gestureZoomFactor(scale, lastGestureScale);
      lastGestureScale = scale;
      const rect = canvas!.getBoundingClientRect();
      const x = (gesture.clientX ?? rect.left + rect.width / 2) - rect.left;
      const y = (gesture.clientY ?? rect.top + rect.height / 2) - rect.top;
      applyZoom(factor, x, y);
    }
    function onGestureEnd(event: Event) {
      event.preventDefault();
      gestureActive = false;
    }
    // Pinch on macOS arrives as Ctrl+wheel; React's passive wheel handler cannot cancel browser zoom.
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("gesturestart", onGestureStart, { passive: false });
    canvas.addEventListener("gesturechange", onGestureChange, { passive: false });
    canvas.addEventListener("gestureend", onGestureEnd, { passive: false });
    return () => {
      if (viewFrame !== undefined) cancelAnimationFrame(viewFrame);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("gesturestart", onGestureStart);
      canvas.removeEventListener("gesturechange", onGestureChange);
      canvas.removeEventListener("gestureend", onGestureEnd);
    };
  }, [viewPreferences.invertZoom, viewPreferences.centerSelection, selectedIds]);

  function measuredBoxes() {
    return new Map(
      [...canvasElements(viewport.current).values()].map((element) => [
        element.dataset.nodeId!,
        renderedNodeBox(element),
      ]),
    );
  }
  function multiSelectionGesture(ids: string[]) {
    const boxes = measuredBoxes();
    const parentId = nodes.find((node) => node.id === ids[0])?.parentId;
    const candidates = nodes
      .filter((node) => node.parentId === parentId && node.visible && !ids.includes(node.id))
      .map((node) => boxes.get(node.id))
      .filter((box): box is DesignNode["box"] => Boolean(box));
    if (candidates.length >= 128) prepareSnapIndex(candidates);
    return { ids, boxes, candidates };
  }
  function multiResizeTarget(
    gesture: NonNullable<typeof multiScaleGesture.current>,
    handle: ResizeHandle,
    delta: { x: number; y: number },
    centered: boolean,
    aspect: boolean,
  ) {
    const bounds = boundingBox(gesture.ids.map((id) => gesture.boxes.get(id)!).filter(Boolean));
    if (!bounds) throw new Error("Select layers to resize.");
    const target = resizeBox(bounds, handle, delta, {
      centered,
      aspect,
      snap: viewPreferences.snapPixels,
    });
    return viewPreferences.snapObjects && !centered && !aspect
      ? snapResize(target, handle, gesture.candidates, 6 / view.zoom)
      : target;
  }
  function wrapSelection(kind: WrapKind) {
    if (readOnly) return;
    try {
      const wrapped = wrapLayers(
        room.getSnapshot().content,
        selectedIds,
        crypto.randomUUID(),
        kind,
        measuredBoxes(),
      );
      void changeDocument(() => wrapped.document, wrapped.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not wrap layers.");
    }
  }

  function snappingGeometry(rootIds: string[]) {
    // Drag setup already resolved movable roots; avoid scanning the document again.
    const roots = new Set(rootIds);
    const descendants = new Set(roots);
    for (const node of nodes) {
      let parent = node.parentId;
      while (parent) {
        if (roots.has(parent)) {
          descendants.add(node.id);
          break;
        }
        parent = nodesById.get(parent)?.parentId ?? null;
      }
    }
    const selectedBoxes: SnapBox[] = [],
      candidates: SnapBox[] = [];
    const parents = new Map<string, { width: number; height: number }>();
    const rect = viewport.current?.getBoundingClientRect();
    if (!rect) return { bounds: null, candidates, parents };
    for (const element of canvasElements(viewport.current).values()) {
      const id = element.dataset.nodeId!;
      if (descendants.has(id) && !roots.has(id)) continue;
      const box = element.getBoundingClientRect();
      const bounds = {
        x: (box.left - rect.left - view.x) / view.zoom,
        y: (box.top - rect.top - view.y) / view.zoom,
        width: box.width / view.zoom,
        height: box.height / view.zoom,
      };
      if (roots.has(id)) {
        selectedBoxes.push(bounds);
        parents.set(id, renderedParentSize(element));
      } else candidates.push(bounds);
    }
    if (candidates.length >= 128) prepareSnapIndex(candidates);
    return { bounds: boundingBox(selectedBoxes), candidates, parents };
  }
  async function edit(id: string, changes: NodeChanges) {
    if (readOnly) return;
    await changeDocument(
      (content) => ({ ...content, nodes: changedLayers(content, [id], changes) }),
      undefined,
      undefined,
      id,
    );
  }

  async function remove(nodeId: string | null = selection) {
    if (!nodeId || readOnly) return;
    setContextMenu(null);
    await changeDocument((content) => removeLayers(content, [nodeId]), null);
  }

  async function duplicate(nodeId?: string | null) {
    if (readOnly) return;
    const ids = nodeId ? [nodeId] : selectedIds;
    const copy = duplicateLayers(room.getSnapshot().content, ids, () => crypto.randomUUID());
    setContextMenu(null);
    await changeDocument(() => copy.document, copy.ids);
  }

  const clipboardRequest = useRef(0);
  const clipboardController = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    clipboardController.current = controller;
    return () => controller.abort();
  }, []);
  const pasteContext = useEditorEvent(() => ({
    selectedIds,
    selection,
    pageId: currentPageId,
    readOnly,
  }));
  const commitClipboard = useEditorEvent(
    (
      payload: DesignClipboard,
      context: {
        selectedIds: string[];
        parentId: string | null;
        pageId: string;
        request: number;
        boxes: Map<string, DesignNode["box"]>;
      },
      inPlace: boolean,
    ) => {
      if (readOnly) return;
      const current = pasteContext();
      if (!documentPages(room.getSnapshot().content).some((page) => page.id === context.pageId))
        throw new Error("The destination page was removed.");
      if (payload.kind === "properties")
        return changeDocument((content) => pasteProperties(content, payload, context.selectedIds));
      const ids = new Map(payload.nodes.map((node) => [node.id, crypto.randomUUID()]));
      let index = 0;
      const rootIds = payload.nodes
        .filter((node) => node.parentId === null)
        .map((node) => ids.get(node.id)!);
      const keepSelection =
        current.pageId !== context.pageId ||
        current.selectedIds !== context.selectedIds ||
        clipboardRequest.current !== context.request;
      return changeDocument(
        (content) =>
          pasteLayers(content, payload, {
            fileId,
            pageId: context.pageId,
            parentId: context.parentId,
            inPlace,
            boxes: current.pageId === context.pageId ? measuredBoxes() : context.boxes,
            createId: () => ids.get(payload.nodes[index++].id)!,
          }).document,
        keepSelection ? undefined : rootIds,
      );
    },
  );
  async function pasteClipboard(
    text: string,
    inPlace = false,
    properties = false,
    origin = { ...pasteContext(), request: ++clipboardRequest.current, boxes: measuredBoxes() },
  ) {
    let payload = readDesignClipboard(text);
    if (!payload) {
      setError("Copy layers or properties from a Tidy file first.");
      return;
    }
    if (readOnly) return;
    if (properties) payload = { ...payload, kind: "properties" };
    const current = origin,
      content = room.getSnapshot().content;
    const selected = content.nodes.find((node) => node.id === current.selection);
    const parentId =
      selected && ["artboard", "container"].includes(selected.type)
        ? selected.id
        : (selected?.parentId ?? null);
    const context = {
      selectedIds: current.selectedIds,
      parentId,
      pageId: current.pageId,
      request: origin.request,
      boxes: origin.boxes,
    };
    const signal = clipboardController.current?.signal;
    try {
      if (current.selection && !selected) throw new Error("The destination layer was removed.");
      // Reject invalid targets before creating any destination assets.
      if (payload.kind === "properties") {
        if (pasteProperties(content, payload, current.selectedIds) === content) return;
      } else
        pasteLayers(content, payload, {
          fileId,
          pageId: current.pageId,
          parentId,
          inPlace,
          boxes: context.boxes,
          createId: () => crypto.randomUUID(),
        });
      const assetIds = clipboardAssetIds(payload);
      if (!local && payload.sourceFile !== fileId && assetIds.length) {
        const response = await fetch(`/api/files/${encodeURIComponent(fileId)}/clipboard-assets`, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceFile: payload.sourceFile, assetIds }),
        });
        const result: { assets?: Record<string, string>; error?: string } = await response.json();
        if (!response.ok || !result.assets)
          throw new Error(result.error ?? "Could not copy clipboard images.");
        payload = remapClipboardAssets(payload, result.assets);
      }
      if (!signal?.aborted) await commitClipboard(payload, context, inPlace);
    } catch (cause) {
      if (!signal?.aborted)
        setError(cause instanceof Error ? cause.message : "Could not paste layers.");
    }
  }

  async function pasteFromSystem(inPlace = false, properties = false) {
    const origin = {
      ...pasteContext(),
      request: ++clipboardRequest.current,
      boxes: measuredBoxes(),
    };
    try {
      await pasteClipboard(await navigator.clipboard.readText(), inPlace, properties, origin);
    } catch {
      setError("Could not read the clipboard.");
    }
  }

  async function copyAppearance() {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(
        copyProperties(selected, room.getSnapshot().content, fileId),
      );
    } catch {
      setError("Could not access the clipboard. Try the keyboard shortcut.");
    }
  }

  useEffect(() => {
    if (readOnly) return;
    const typing = () =>
      document.activeElement?.closest("input, textarea, select, [contenteditable]");
    function copy(event: ClipboardEvent) {
      if (typing() || !selectedIds.length || !event.clipboardData) return;
      if (
        event.type === "cut" &&
        selectedIds.some((id) => isLayerLocked(room.getSnapshot().content.nodes, id))
      ) {
        event.preventDefault();
        setError("Unlock selected layers before cutting them.");
        return;
      }
      try {
        event.clipboardData.setData(
          "text/plain",
          copyLayers(room.getSnapshot().content, selectedIds, fileId, measuredBoxes()),
        );
        event.preventDefault();
        if (event.type === "cut")
          void changeDocument((content) => removeLayers(content, selectedIds), null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not copy layers.");
      }
    }
    function paste(event: ClipboardEvent) {
      if (typing() || !event.clipboardData) return;
      const text = event.clipboardData.getData("text/plain");
      if (readDesignClipboard(text)) {
        event.preventDefault();
        pasteClipboard(text);
        return;
      }
      const images = Array.from(event.clipboardData.files).filter((file) =>
        file.type.startsWith("image/"),
      );
      if (images.length) {
        event.preventDefault();
        void uploadImages(images);
      }
    }
    window.addEventListener("copy", copy);
    window.addEventListener("cut", copy);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("copy", copy);
      window.removeEventListener("cut", copy);
      window.removeEventListener("paste", paste);
    };
  });

  useEffect(() => {
    if (readOnly) return;
    function clipboardShortcut(event: KeyboardEvent) {
      if (
        event.isComposing ||
        event.repeat ||
        !(event.metaKey || event.ctrlKey) ||
        (event.target instanceof Element &&
          event.target.closest("input, textarea, select, [contenteditable]"))
      )
        return;
      if (event.altKey && event.key.toLowerCase() === "c") {
        event.preventDefault();
        void copyAppearance();
      }
      if (event.key.toLowerCase() === "v" && (event.altKey || event.shiftKey)) {
        event.preventDefault();
        void pasteFromSystem(event.shiftKey, event.altKey);
      }
    }
    window.addEventListener("keydown", clipboardShortcut);
    return () => window.removeEventListener("keydown", clipboardShortcut);
  });

  function openNodeMenu(event: MouseEvent<HTMLElement>, nodeId: string) {
    if (viewPreferences.rightClickPan) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (readOnly) return;
    event.preventDefault();
    event.stopPropagation();
    if (!selectedIds.includes(nodeId)) selectNode(nodeId);
    const behindIds: string[] = [];
    if (event.currentTarget.hasAttribute("data-node-id")) {
      const seen = new Set([nodeId]);
      for (const element of document.elementsFromPoint(event.clientX, event.clientY)) {
        const id = element.closest("[data-node-id]")?.getAttribute("data-node-id");
        if (id && !seen.has(id) && nodes.some((node) => node.id === id)) {
          seen.add(id);
          behindIds.push(id);
        }
      }
    }
    const node = nodes.find((item) => item.id === nodeId);
    const selectionCount = selectedIds.includes(nodeId) ? selectedIds.length : 1;
    const itemCount =
      9 +
      Number(node?.type !== "artboard") +
      Number(node?.type === "container") +
      Number(Boolean(node && !node.isComponent && !node.instanceOf && node.type !== "artboard")) +
      Number(Boolean(node?.isComponent)) +
      Number(
        selectionCount === 1 &&
          Boolean(
            node &&
            ["artboard", "container"].includes(node.type) &&
            nodes.some((child) => child.parentId === node.id && child.visible),
          ),
      );
    setContextMenu({
      ...layerMenuPosition(event.clientX, event.clientY, itemCount + behindIds.length),
      nodeId,
      behindIds,
    });
  }

  useLayoutEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        readOnly ||
        prototypeMode ||
        (vectorMode === selection && tool === "select") ||
        tool === "pen" ||
        event.repeat ||
        event.isComposing
      )
        return;
      if (
        event.target instanceof Element &&
        event.target.closest("input, textarea, select, [contenteditable]")
      )
        return;
      if (cropping && !event.metaKey && !event.ctrlKey) {
        if (event.key === "Escape" || event.key === "Enter") {
          event.preventDefault();
          cropDrag.current = null;
          room.restore();
          setCropId(null);
          return;
        }
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
          event.preventDefault();
          const step = event.shiftKey ? 10 : 1;
          const element = canvasElements(viewport.current).get(cropId ?? "");
          const crop = panImageCrop(
            selected!.style.imageCrop!,
            imageViewport(selected!, element ? renderedNodeBox(element) : selected!.box),
            {
              x: event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0,
              y: event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0,
            },
          );
          void edit(cropId!, { style: { imageCrop: crop } });
          return;
        }
        if (event.key === "+" || event.key === "=" || event.key === "-") {
          event.preventDefault();
          void edit(cropId!, {
            style: {
              imageCrop: zoomImageCrop(
                selected!.style.imageCrop!,
                event.key === "-" ? 1 / 1.1 : 1.1,
              ),
            },
          });
          return;
        }
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "g") {
        event.preventDefault();
        if (event.shiftKey && !event.altKey && selection)
          void changeDocument((content) => unwrapLayer(content, selection, measuredBoxes()), null);
        else wrapSelection(event.altKey ? "frame" : "group");
        return;
      }
      if (!event.metaKey && !event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "a") {
        event.preventDefault();
        wrapSelection("auto");
        return;
      }
      if (event.altKey) return;
      if (
        event.target instanceof Element &&
        event.target.closest("input, textarea, select, [contenteditable]")
      )
        return;
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "a") {
        event.preventDefault();
        const ids = nodes
          .filter((node) => node.parentId === (selected?.parentId ?? null))
          .map((node) => node.id);
        setSelectedIds(ids);
        setSelection(ids.at(-1) ?? null);
        return;
      }
      if (!selection) return;
      if (!command && event.key === "Enter") {
        event.preventDefault();
        if (selected?.type === "text") {
          setEditingTextId(selection);
          editingRef.current = true;
        } else {
          const child = nodes.find((node) => node.parentId === selection);
          if (child) selectNode(child.id);
        }
        return;
      }
      if (!command && event.key === "Escape") {
        event.preventDefault();
        if (selected?.parentId) selectNode(selected.parentId);
        else {
          setSelectedIds([]);
          setSelection(null);
        }
        return;
      }
      if (!command && event.key === "Tab") {
        event.preventDefault();
        const siblings = nodes.filter((node) => node.parentId === selected?.parentId);
        const index = siblings.findIndex((node) => node.id === selection);
        const next =
          siblings[(index + (event.shiftKey ? -1 : 1) + siblings.length) % siblings.length];
        if (next) selectNode(next.id);
        return;
      }

      if (
        event.target instanceof Element &&
        event.target.closest("input, textarea, select, [contenteditable]")
      )
        return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d") {
        event.preventDefault();
        void duplicate();
        return;
      }
      if (
        !event.metaKey &&
        !event.ctrlKey &&
        ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
      ) {
        event.preventDefault();
        const step = nudgeStep * (event.shiftKey ? 10 : 1);
        // Nudges need selected parent sizes, not the drag gesture's full scene snap index.
        const parents = new Map(
          selectedElements(viewport.current, selectedIds).map((element) => [
            element.dataset.nodeId!,
            renderedParentSize(element),
          ]),
        );
        void changeDocument((content) => ({
          ...content,
          nodes: movedLayers(
            content,
            selectedIds,
            event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0,
            event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0,
            parents,
          ),
        }));
        return;
      }
      if (event.metaKey || event.ctrlKey || (event.key !== "Backspace" && event.key !== "Delete"))
        return;
      event.preventDefault();
      if (selectedIds.length > 1)
        void changeDocument((content) => removeLayers(content, selectedIds), null);
      else void remove(selection);
    }
    selectionKeyHandler.current = onKeyDown;
  });

  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => selectionKeyHandler.current(event);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        (event.target instanceof Element &&
          event.target.closest("input, textarea, select, [contenteditable]"))
      )
        return;
      const command = event.metaKey || event.ctrlKey;
      if (event.shiftKey && event.code === "Quote") {
        event.preventDefault();
        toggleViewPreference(command ? "snapPixels" : "pixelGrid");
        return;
      }
      if (command) return;
      if (event.shiftKey && event.code === "KeyG") {
        event.preventDefault();
        toggleViewPreference("guides");
        return;
      }
      if (event.shiftKey && event.code === "KeyC") {
        event.preventDefault();
        toggleViewPreference("comments");
        return;
      }
      if (event.shiftKey && ["Digit0", "Digit1", "Digit2"].includes(event.code)) {
        event.preventDefault();
        zoomView(
          event.code === "Digit0" ? "actual" : event.code === "Digit1" ? "fit" : "selection",
        );
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomView("in");
        return;
      }
      if (event.key === "-") {
        event.preventDefault();
        zoomView("out");
        return;
      }
      if (viewPreferences.numberKeys && /^Digit[0-9]$/.test(event.code)) {
        event.preventDefault();
        const number = Number(event.code.slice(-1));
        zoomView(number === 0 ? 1 : number / 10);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  function worldPoint(event: { clientX: number; clientY: number }): Point {
    const bounds = viewport.current!.getBoundingClientRect();
    return canvasWorldPoint(
      { x: event.clientX, y: event.clientY },
      { x: bounds.left, y: bounds.top },
      view,
      viewPreferences.snapPixels,
    );
  }

  async function createDrawnNode(
    type: "artboard" | "container" | "text",
    parentId: string | null,
    box: DesignNode["box"],
    shape?: NativeShape,
  ) {
    const id = crypto.randomUUID();
    const node = {
      ...(shape
        ? buildNativeShape(id, shape, parentId, box)
        : buildDrawnNode(id, type, parentId, box)),
      pageId: currentPageId,
    };
    await changeDocument((content) => ({ ...content, nodes: [...content.nodes, node] }), id);
  }

  function beginVectorEditing(node: DesignNode) {
    if (readOnly || !node.vectorPath || isLayerLocked(nodes, node.id)) return;
    try {
      if (!node.vectorPath.contours) parsePathContours(node.vectorPath.d);
      setCropId(null);
      setGradientMode(null);
      setTool("select");
      setVectorMode(node.id);
    } catch {
      setError("This path cannot be edited as points. Its original rendering is retained.");
    }
  }

  function finishPen(contour: VectorContour, parentId: string | null, pageId: string) {
    const all = contour.points.flatMap((p) => [
      p,
      ...(p.in ? [p.in] : []),
      ...(p.out ? [p.out] : []),
    ]);
    const x = Math.min(...all.map((p) => p.x)),
      y = Math.min(...all.map((p) => p.y));
    const width = Math.max(1, Math.max(...all.map((p) => p.x)) - x),
      height = Math.max(1, Math.max(...all.map((p) => p.y)) - y);
    const shift = (p: Point) => ({ x: p.x - x, y: p.y - y });
    const contours = [
      {
        ...contour,
        points: contour.points.map((p) => ({
          ...p,
          ...shift(p),
          in: p.in ? shift(p.in) : undefined,
          out: p.out ? shift(p.out) : undefined,
        })),
      },
    ];
    const id = crypto.randomUUID();
    void changeDocument((content) => {
      const parent = content.nodes.find((n) => n.id === parentId);
      if (
        pageId !== currentPageId ||
        (parentId &&
          (!parent ||
            isLayerLocked(content.nodes, parentId) ||
            !parent.visible ||
            nodePageId(parent) !== pageId))
      )
        throw new Error("The path's page or parent is no longer editable.");
      const node: DesignNode = {
        id,
        parentId,
        pageId,
        name: "Path",
        type: "vector",
        box: { x, y, width, height },
        vectorPath: {
          d: serializeContours(contours),
          contours,
          viewBox: { x: 0, y: 0, width, height },
          fillRule: "nonzero",
        },
        style: {
          paints: [],
          strokePaints: [
            { id: crypto.randomUUID(), type: "solid", color: "#111111", opacity: 1, visible: true },
          ],
          borderWidth: 2,
          strokeCap: "round",
          strokeJoin: "round",
        },
        layout: "absolute",
        positionMode: parentId ? "absolute" : undefined,
        visible: true,
        locked: false,
      };
      return { ...content, nodes: [...content.nodes, node] };
    }, id);
    setTool("select");
    setVectorMode(id);
  }

  function beginCanvasGesture(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 && !(event.button === 2 && viewPreferences.rightClickPan)) return;
    event.preventDefault();
    viewport.current?.focus({ preventScroll: true });
    if (tool === "hand" || spaceHeld || event.button === 2) {
      pan.current = { x: event.clientX, y: event.clientY, left: view.x, top: view.y };
      setPanning(true);
      viewport.current?.setPointerCapture(event.pointerId);
      return;
    }
    if (prototypeMode) return;
    if (tool === "comment") {
      placeComment(event.clientX, event.clientY);
      return;
    }
    if (tool === "select") {
      const bounds = viewport.current!.getBoundingClientRect();
      const start = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      marqueeRef.current = { start, end: start, additive: event.shiftKey ? selectedIds : [] };
      setMarquee(marqueeRef.current);
      if (!event.shiftKey) {
        setSelection(null);
        setSelectedIds([]);
      }
      viewport.current?.setPointerCapture(event.pointerId);
      return;
    }
    if (readOnly || tool === "pen") return;
    let parentId: string | null = null;
    if (tool === "rectangle" || tool === "text" || isShapeKind(tool)) {
      const sourceId = (event.target as Element)
        .closest("[data-node-id]")
        ?.getAttribute("data-node-id");
      let current = nodes.find((node) => node.id === sourceId);
      while (current && !["artboard", "container"].includes(current.type))
        current = nodes.find((node) => node.id === current?.parentId);
      if (current?.locked) {
        setError("This frame or container is locked.");
        return;
      }
      parentId = current?.id ?? null;
    }
    setError("");
    const start = worldPoint(event);
    if (tool === "text") {
      const parentPosition = parentId ? absoluteNodePosition(nodes, parentId) : { x: 0, y: 0 };
      void createDrawnNode("text", parentId, {
        x: start.x - parentPosition.x,
        y: start.y - parentPosition.y,
        width: 200,
        height: 48,
      });
      return;
    }
    drawingRef.current = {
      start,
      end: start,
      type: tool === "frame" ? "artboard" : "container",
      shape: isShapeKind(tool) ? tool : undefined,
      parentId,
    };
    setDrawing(drawingRef.current);
    if (drawingRef.current) {
      const box = drawingBox(drawingRef.current.start, drawingRef.current.end);
      if (box.width >= 1 && box.height >= 1 && box.width <= 5000 && box.height <= 5000)
        room.publishPresence({ preview: { box } });
    }
    viewport.current?.setPointerCapture(event.pointerId);
  }

  function moveCanvasGesture(event: PointerEvent<HTMLDivElement>) {
    if (pan.current) {
      const start = pan.current;
      setView((current) => ({
        ...current,
        x: start.left + event.clientX - start.x,
        y: start.top + event.clientY - start.y,
      }));
    } else if (drawingRef.current) {
      drawingRef.current = { ...drawingRef.current, end: worldPoint(event) };
      setDrawing(drawingRef.current);
      if (drawingRef.current) {
        const box = drawingBox(drawingRef.current.start, drawingRef.current.end);
        if (box.width >= 1 && box.height >= 1 && box.width <= 5000 && box.height <= 5000)
          room.publishPresence({ preview: { box } });
      }
    } else if (marqueeRef.current) {
      const bounds = viewport.current!.getBoundingClientRect();
      marqueeRef.current = {
        ...marqueeRef.current,
        end: { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      };
      setMarquee(marqueeRef.current);
    }
  }

  const canvasMoveFrame = useFrameEvent(moveCanvasGesture);

  async function finishCanvasGesture(event: PointerEvent<HTMLDivElement>) {
    canvasMoveFrame.cancel();
    if (pan.current) moveCanvasGesture(event);
    if (viewport.current?.hasPointerCapture(event.pointerId))
      viewport.current.releasePointerCapture(event.pointerId);
    if (pan.current) {
      pan.current = null;
      setPanning(false);
      return;
    }
    if (marqueeRef.current) {
      const current = marqueeRef.current;
      marqueeRef.current = null;
      setMarquee(null);
      const bounds = viewport.current!.getBoundingClientRect();
      const end = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
      const area = drawingBox(current.start, end);
      if (area.width < 3 && area.height < 3) return;
      const hits = Array.from(canvasElements(viewport.current).values())
        .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.left >= bounds.left + area.x &&
            rect.top >= bounds.top + area.y &&
            rect.right <= bounds.left + area.x + area.width &&
            rect.bottom <= bounds.top + area.y + area.height
          );
        })
        .map((element) => element.dataset.nodeId!)
        .filter((id) => nodes.some((node) => node.id === id) && !isLayerLocked(nodes, id));
      const next = [...new Set([...current.additive, ...hits])];
      setSelectedIds(next);
      setSelection(next.at(-1) ?? null);
      return;
    }
    const gesture = drawingRef.current;
    if (!gesture) return;
    drawingRef.current = null;
    setDrawing(null);
    const end = worldPoint(event);
    const worldBox = drawingBox(gesture.start, end);
    const line = gesture.shape === "line" || gesture.shape === "arrow";
    if (line && (worldBox.width >= 1 || worldBox.height >= 1)) {
      worldBox.width = Math.max(1, worldBox.width);
      worldBox.height = Math.max(1, worldBox.height);
    }
    const minimum = gesture.type === "artboard" ? 40 : 1;
    if (worldBox.width < minimum || worldBox.height < minimum) {
      room.publishPresence({ preview: null, action: isShapeKind(tool) ? "rectangle" : tool }, true);
      return;
    }
    if (worldBox.width > 5000 || worldBox.height > 5000) {
      room.publishPresence({ preview: null, action: isShapeKind(tool) ? "rectangle" : tool }, true);
      setError("Layers can be up to 5000 × 5000 pixels.");
      return;
    }
    const parentId = containingDrawParent(nodes, gesture.parentId, worldBox);
    const parentPosition = parentId ? absoluteNodePosition(nodes, parentId) : { x: 0, y: 0 };
    const box = { ...worldBox, x: worldBox.x - parentPosition.x, y: worldBox.y - parentPosition.y };
    await createDrawnNode(
      gesture.type,
      parentId,
      box,
      gesture.shape
        ? {
            kind: gesture.shape,
            reverseX: end.x < gesture.start.x,
            reverseY: end.y < gesture.start.y,
          }
        : undefined,
    );
  }

  function patchSelection(changes: NodeChanges | ((node: DesignNode) => NodeChanges)) {
    if (
      typeof changes !== "function" &&
      changes.style?.objectFit &&
      changes.style.objectFit !== "cover"
    )
      setCropId(null);
    const elements = canvasElements(viewport.current);
    void changeDocument(
      (content) => ({
        ...content,
        nodes: changedLayers(content, selectedIds, (item) => {
          const element = elements.get(item.id);
          const actual = element ? { ...item, box: renderedNodeBox(element) } : item;
          const patch = typeof changes === "function" ? changes(actual) : changes;
          if (
            !element ||
            !(
              patch.box ||
              patch.widthMode ||
              patch.heightMode ||
              patch.horizontalConstraint ||
              patch.verticalConstraint
            )
          )
            return patch;
          const parent = content.nodes.find((node) => node.id === item.parentId);
          const after = { ...actual, ...patch, box: { ...actual.box, ...patch.box } };
          return {
            ...patch,
            box: storedConstraintBox(after.box, after, parent, renderedParentSize(element)),
          };
        }),
      }),
      undefined,
      undefined,
      selectedIds.length === 1 ? selectedIds[0] : undefined,
    );
  }

  function toggleCrop() {
    gradientGesture.current = null;
    setGradientMode(null);
    room.restore();
    if (cropping) {
      setCropId(null);
      viewport.current?.focus();
      return;
    }
    if (
      !selected ||
      selectedIds.length !== 1 ||
      !["image", "vector"].includes(selected.type) ||
      readOnly ||
      isLayerLocked(nodes, selected.id)
    )
      return;
    const element = canvasElements(viewport.current).get(selected.id);
    const image = loadedImageSize(element?.querySelector("img"));
    if (!selected.style.imageCrop && !image) {
      setError("Wait for the image to load before cropping.");
      return;
    }
    const crop = initialImageCrop(
      selected,
      element ? renderedNodeBox(element) : selected.box,
      selected.style.imageCrop?.sourceWidth ?? image!.width,
      selected.style.imageCrop?.sourceHeight ?? image!.height,
    );
    void edit(selected.id, {
      style: {
        imageCrop: crop,
        objectFit: "cover",
        objectPositionX: 50,
        objectPositionY: 50,
        objectScale: 1,
      },
    });
    setCropId(selected.id);
    setError("");
    viewport.current?.focus();
  }
  function cropDelta(event: PointerEvent, start: NonNullable<typeof cropDrag.current>) {
    const x = event.clientX - start.x,
      y = event.clientY - start.y;
    return {
      x: start.inverse.a * x + start.inverse.c * y,
      y: start.inverse.b * x + start.inverse.d * y,
    };
  }
  function beginCropPan(event: PointerEvent<HTMLDivElement>, node: DesignNode) {
    event.preventDefault();
    event.stopPropagation();
    viewport.current?.focus();
    let matrix = new DOMMatrix();
    for (
      let element: HTMLElement | null = event.currentTarget;
      element && element !== viewport.current;
      element = element.parentElement
    ) {
      const transform = getComputedStyle(element).transform;
      if (transform !== "none") matrix = new DOMMatrix(transform).multiply(matrix);
    }
    cropDrag.current = {
      id: node.id,
      x: event.clientX,
      y: event.clientY,
      inverse: matrix.inverse(),
      box: imageViewport(node, renderedNodeBox(event.currentTarget)),
      crop: initialImageCrop(
        node,
        renderedNodeBox(event.currentTarget),
        node.style.imageCrop!.sourceWidth,
        node.style.imageCrop!.sourceHeight,
      ),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function dragDelta(event: PointerEvent, start: NonNullable<typeof drag.current>) {
    const delta = {
      x: snapCoordinate((event.clientX - start.x) / view.zoom),
      y: snapCoordinate((event.clientY - start.y) / view.zoom),
    };
    if (event.ctrlKey || event.metaKey || !start.bounds)
      return { ...delta, guides: [], spacing: [] };
    const snapped = viewPreferences.snapObjects
      ? snapTranslation(start.bounds, delta, start.candidates, 6 / view.zoom)
      : { ...delta, guides: [] };
    return {
      ...snapped,
      spacing: equalSpacingCues(start.bounds, snapped, start.candidates, 1 / view.zoom),
    };
  }

  const artworkDoubleClick = useEditorEvent(
    (node: DesignNode, event: MouseEvent<HTMLDivElement>) => {
      if (readOnly || isLayerLocked(nodes, node.id)) return;
      if (node.vectorPath) {
        event.preventDefault();
        event.stopPropagation();
        selectNode(node.id);
        beginVectorEditing(node);
        return;
      }
      if (node.type !== "text") return;
      event.stopPropagation();
      selectNode(node.id);
      editingRef.current = true;
      setEditingTextId(node.id);
    },
  );
  function beginLayerDrag(event: PointerEvent<HTMLDivElement>, ids: string[], id: string) {
    if (drag.current || readOnly) return;
    // Eligibility belongs to the selected roots, not the child under the cursor.
    const movable = movableSelectionRoots(nodes, ids);
    if (!movable.length) return;
    event.preventDefault();
    viewport.current?.focus({ preventScroll: true });
    const movingIds = movable.map((node) => node.id);
    drag.current = {
      pointerId: event.pointerId,
      id: movingIds.includes(id) ? id : movingIds[0],
      x: event.clientX,
      y: event.clientY,
      ids: movingIds,
      before: room.getSnapshot(),
      ...snappingGeometry(movingIds),
    };
    // The viewport stays mounted even when artwork is culled or updated mid-drag.
    viewport.current?.setPointerCapture(event.pointerId);
  }

  function beginSelectedLayersDrag(event: PointerEvent<HTMLDivElement>) {
    if (
      event.button !== 0 ||
      event.shiftKey ||
      selectedIds.length < 2 ||
      tool !== "select" ||
      spaceHeld ||
      readOnly ||
      prototypeMode ||
      cropping ||
      vectorMode ||
      editingTextId ||
      editingGradient ||
      (event.target as Element).closest("button, a, input, textarea, select, [data-canvas-control]")
    )
      return;
    const hitId =
      (event.target as Element).closest("[data-node-id]")?.getAttribute("data-node-id") ?? null;
    const target = selectionDragTarget(nodesById, selectedIds, hitId);
    if (!target) return;
    if (
      target.kind === "gap" &&
      !selectionContainsPoint(viewport.current, selectedIds, event.clientX, event.clientY)
    )
      return;
    event.stopPropagation();
    beginLayerDrag(event, selectedIds, target.kind === "layer" ? target.id : selectedIds[0]);
  }

  const artworkPointerDown = useEditorEvent(
    (node: DesignNode, event: PointerEvent<HTMLDivElement>) => {
      if (event.button === 2 && viewPreferences.rightClickPan) {
        event.stopPropagation();
        beginCanvasGesture(event);
        return;
      }
      if (event.button !== 0) return;
      if (
        !viewPreferences.deepSelection &&
        tool === "select" &&
        !spaceHeld &&
        node.parentId &&
        nodes.find((item) => item.id === node.parentId)?.type === "container" &&
        !selectedIds.includes(node.parentId) &&
        !selectedIds.includes(node.id)
      )
        return;
      event.stopPropagation();
      if (prototypeMode) {
        let target: DesignNode | undefined = node;
        while (target && !target.linkTo)
          target = nodes.find((item) => item.id === target?.parentId);
        if (target?.linkTo) showPrototypeArtboard(target.linkTo);
        return;
      }
      if (tool === "comment" && !spaceHeld) {
        placeComment(event.clientX, event.clientY);
        return;
      }
      if (tool !== "select" || spaceHeld) {
        beginCanvasGesture(event);
        return;
      }
      if (!readOnly && isLayerLocked(nodes, node.id)) return;
      if (vectorMode === node.id) return;
      setVectorMode(null);
      if (cropping && node.id === cropId) {
        beginCropPan(event, node);
        return;
      }
      if (event.shiftKey) {
        selectNode(node.id, true);
        return;
      }
      const ids = selectedIds.includes(node.id) ? selectedIds : [node.id];
      if (!selectedIds.includes(node.id)) selectNode(node.id);
      if (readOnly) return;
      beginLayerDrag(event, ids, node.id);
    },
  );
  const artworkMoveFrame = useFrameEvent(
    (node: DesignNode, event: PointerEvent<HTMLDivElement>) => {
      const cropStart = cropDrag.current;
      if (cropStart?.id === node.id) {
        const before = room.getSnapshot();
        setSnapshot({
          ...before,
          content: previewLayerChanges(before.content, [node.id], {
            style: {
              imageCrop: panImageCrop(cropStart.crop, cropStart.box, cropDelta(event, cropStart)),
            },
          }),
        });
        return;
      }
      const start = drag.current;
      if (start?.id !== node.id || start.pointerId !== event.pointerId) return;
      const { x, y, guides, spacing } = dragDelta(event, start);
      setSnapGuides(guides);
      setSpacingCues(spacing);
      const latest = room.getSnapshot();
      const content = previewMoveLayers(latest.content, start.ids, x, y, start.parents);
      setSnapshot({ ...latest, content });
      room.publishPresence({
        action: "move",
        preview: {
          nodeId: node.id,
          box: content.nodes.find((item) => item.id === node.id)!.box,
        },
      });
    },
  );
  const artworkPointerMove = useEditorEvent(
    (node: DesignNode, event: PointerEvent<HTMLDivElement>) => {
      if (
        (drag.current?.id === node.id && drag.current.pointerId === event.pointerId) ||
        cropDrag.current?.id === node.id
      )
        artworkMoveFrame.schedule(node, event);
    },
  );
  const artworkPointerUp = useEditorEvent(
    (node: DesignNode, event: PointerEvent<HTMLDivElement>) => {
      if (drag.current && drag.current.pointerId !== event.pointerId) return;
      artworkMoveFrame.cancel();
      const cropStart = cropDrag.current;
      if (cropStart?.id === node.id) {
        cropDrag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
        const crop = panImageCrop(cropStart.crop, cropStart.box, cropDelta(event, cropStart));
        void edit(node.id, { style: { imageCrop: crop } });
        return;
      }
      const start = drag.current;
      if (start?.id !== node.id || start.pointerId !== event.pointerId) return;
      drag.current = null;
      if (viewport.current?.hasPointerCapture(event.pointerId))
        viewport.current.releasePointerCapture(event.pointerId);
      const { x, y } = dragDelta(event, start);
      setSnapGuides([]);
      setSpacingCues([]);
      if (x || y)
        void changeDocument((content) => ({
          ...content,
          nodes: movedLayers(content, start.ids, x, y, start.parents),
        }));
      else {
        room.restore();
        room.publishPresence(
          { preview: null, action: isShapeKind(tool) ? "rectangle" : tool },
          true,
        );
      }
    },
  );
  const artworkCancel = useEditorEvent(() => {
    artworkMoveFrame.cancel();
    cropDrag.current = null;
    drag.current = null;
    setSnapGuides([]);
    setSpacingCues([]);
    room.restore();
    room.publishPresence({ preview: null, action: "select" }, true);
    setSnapshot(room.getSnapshot());
  });
  const artworkTextDraft = useEditorEvent((node: DesignNode, value: TextContent) => {
    room.publishPresence({
      action: "typing",
      preview: { nodeId: node.id, text: value.text.slice(0, 8000) },
    });
  });
  const artworkTextFinish = useEditorEvent((node: DesignNode, value: TextContent | null) => {
    setEditingTextId(null);
    editingRef.current = false;
    if (
      value !== null &&
      (value.text !== node.text || JSON.stringify(value.richText) !== JSON.stringify(node.richText))
    )
      void edit(node.id, value);
    else
      room.publishPresence({ action: isShapeKind(tool) ? "rectangle" : tool, preview: null }, true);
  });

  const toolRail = (
    <div role="toolbar" aria-label="Canvas tools" className="flex flex-col items-center gap-1">
      <CanvasToolButton
        label="Select tool"
        hint="Select · V"
        pressed={tool === "select"}
        onClick={() => setTool("select")}
      >
        <Icon name="select" />
      </CanvasToolButton>
      {!permissionReadOnly && (
        <CanvasToolButton
          label="Inspect mode"
          hint="Inspect · read-only handoff"
          pressed={inspectorMode === "inspect"}
          onClick={() => {
            setInspectorMode((mode) => (mode === "inspect" ? "design" : "inspect"));
            setTool("select");
            setEditingTextId(null);
            editingRef.current = false;
            setCropId(null);
            setGradientMode(null);
          }}
        >
          <svg
            aria-hidden="true"
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          >
            <path d="m6 5-4 5 4 5m8-10 4 5-4 5M12 3 8 17" />
          </svg>
        </CanvasToolButton>
      )}
      <CanvasToolButton
        label="Hand tool"
        hint="Hand · H or hold Space"
        pressed={tool === "hand"}
        onClick={() => setTool("hand")}
      >
        <Icon name="hand" />
      </CanvasToolButton>
      {!readOnly && (
        <CanvasToolButton
          label="Frame tool"
          hint="Frame · F, then drag"
          pressed={tool === "frame"}
          onClick={() => setTool("frame")}
        >
          <Icon name="frame" />
        </CanvasToolButton>
      )}
      {!readOnly && (
        <CanvasToolButton
          label="Rectangle tool"
          hint="Rectangle · R, then drag"
          pressed={tool === "rectangle"}
          onClick={() => setTool("rectangle")}
        >
          <Icon name="rectangle" />
        </CanvasToolButton>
      )}
      {!readOnly && (
        <SelectMenu
          label="Shape tool"
          value={isShapeKind(tool) ? tool : ""}
          options={shapeKinds.map((kind) => ({
            value: kind,
            label: kind[0].toUpperCase() + kind.slice(1),
          }))}
          onChange={(value) => {
            if (isShapeKind(value)) setTool(value);
          }}
          triggerContent={
            <svg
              aria-hidden="true"
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
            >
              <circle cx="10" cy="10" r="7" />
              <path d="M10 3L17 14H3Z" />
            </svg>
          }
          triggerClassName={`flex h-9 w-9 items-center justify-center rounded-md ${isShapeKind(tool) ? "bg-primary-orange/15" : ""}`}
          size="sm"
        />
      )}
      {!readOnly && (
        <CanvasToolButton
          label="Pen tool"
          hint="Pen · P, click or drag points"
          pressed={tool === "pen"}
          onClick={() => {
            setVectorMode(null);
            setTool("pen");
          }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor">
            <path d="M3 13 5 5 11 2 14 5 11 11Z M3 13 8 8" />
            <circle cx="9" cy="7" r="1" />
          </svg>
        </CanvasToolButton>
      )}
      {!readOnly && (
        <CanvasToolButton
          label="Text tool"
          hint="Text · T, then click"
          pressed={tool === "text"}
          onClick={() => setTool("text")}
        >
          <span className="text-sm font-semibold">T</span>
        </CanvasToolButton>
      )}
      {!readOnly && (
        <CanvasToolButton
          label="Add image"
          hint={uploading ? "Uploading image…" : "Add image"}
          onClick={() => {
            if (!uploading) imageInput.current?.click();
          }}
        >
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none">
            <rect
              x="2.5"
              y="3"
              width="15"
              height="14"
              rx="1"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <circle cx="13.5" cy="7" r="1.5" stroke="currentColor" strokeWidth="1.2" />
            <path
              d="m3 14 4.5-5 5 5 2-2 3 3"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
        </CanvasToolButton>
      )}
      {!preview && (
        <CanvasToolButton
          label="Comment tool"
          hint="Comment · C, then click"
          pressed={tool === "comment"}
          onClick={() => setTool("comment")}
        >
          <Icon name="comment" />
        </CanvasToolButton>
      )}
    </div>
  );

  const contextNode = contextMenu ? nodes.find((node) => node.id === contextMenu.nodeId) : null;
  const contextItems: LayerMenuItem[] = contextNode
    ? [
        ...contextMenu!.behindIds.map((id, index) => ({
          label: `Select behind ${index + 1}: ${nodes.find((node) => node.id === id)?.name ?? "Layer"}`,
          onSelect: () => selectNode(id),
        })),
        { label: "Copy properties", shortcut: "⌥⌘C", onSelect: () => void copyAppearance() },
        {
          label: "Paste properties",
          shortcut: "⌥⌘V",
          disabled: isLayerLocked(nodes, contextNode.id),
          onSelect: () => void pasteFromSystem(false, true),
        },
        ...(contextNode.type !== "artboard"
          ? [
              {
                label: "Wrap in frame",
                shortcut: "⌥⌘G",
                disabled: isLayerLocked(nodes, contextNode.id),
                onSelect: () => wrapSelection("frame"),
              },
            ]
          : []),
        {
          label: "Add auto layout",
          shortcut: "⇧A",
          disabled: isLayerLocked(nodes, contextNode.id),
          onSelect: () => wrapSelection("auto"),
        },
        {
          label: "Duplicate",
          shortcut: "⌘D",
          disabled: isLayerLocked(nodes, contextNode.id),
          onSelect: () => void duplicate(contextNode.id),
        },
        {
          label: "Flip horizontally",
          disabled: isLayerLocked(nodes, contextNode.id),
          onSelect: () => void edit(contextNode.id, { style: { flipX: !contextNode.style.flipX } }),
        },
        {
          label: "Flip vertically",
          disabled: isLayerLocked(nodes, contextNode.id),
          onSelect: () => void edit(contextNode.id, { style: { flipY: !contextNode.style.flipY } }),
        },
        {
          label: "Bring forward",
          disabled: isLayerLocked(nodes, contextNode.id),
          onSelect: () =>
            void changeDocument((content) => moveLayer(content, contextNode.id, 1), contextNode.id),
        },
        {
          label: "Send backward",
          disabled: isLayerLocked(nodes, contextNode.id),
          onSelect: () =>
            void changeDocument(
              (content) => moveLayer(content, contextNode.id, -1),
              contextNode.id,
            ),
        },
        ...(contextNode.type === "container"
          ? [
              {
                label: "Ungroup",
                disabled:
                  isLayerLocked(nodes, contextNode.id) ||
                  Boolean(contextNode.isComponent || contextNode.instanceOf),
                onSelect: () =>
                  void changeDocument(
                    (content) => unwrapLayer(content, contextNode.id, measuredBoxes()),
                    null,
                  ),
              },
            ]
          : []),
        ...(selectedIds.length === 1 &&
        ["artboard", "container"].includes(contextNode.type) &&
        nodes.some((node) => node.parentId === contextNode.id && node.visible)
          ? [
              {
                label: "Fit to content",
                disabled: isLayerLocked(nodes, contextNode.id),
                onSelect: () =>
                  void changeDocument((content) =>
                    fitContents(content, contextNode.id, measuredBoxes()),
                  ),
              },
            ]
          : []),
        ...(!contextNode.isComponent && !contextNode.instanceOf && contextNode.type !== "artboard"
          ? [
              {
                label: "Make component",
                disabled: isLayerLocked(nodes, contextNode.id),
                onSelect: () =>
                  void changeDocument(
                    (content) => makeComponent(content, contextNode.id),
                    contextNode.id,
                  ),
              },
            ]
          : []),
        ...(contextNode.isComponent
          ? [
              {
                label: "Create instance",
                disabled: false,
                onSelect: () =>
                  void changeDocument(
                    (content) =>
                      createComponentInstance(content, contextNode.id, () => crypto.randomUUID())
                        .document,
                    contextNode.id,
                  ),
              },
            ]
          : []),
        {
          label: "Delete",
          shortcut: "⌫",
          danger: true,
          disabled: isLayerLocked(nodes, contextNode.id),
          onSelect: () => void remove(contextNode.id),
        },
      ]
    : [];
  const pageMenuIndex = pages.findIndex((page) => page.id === pageMenu?.pageId);
  const pageMenuItems: LayerMenuItem[] =
    pageMenu && !readOnly
      ? [
          {
            label: "Rename",
            disabled: false,
            onSelect: () => {
              const page = pages[pageMenuIndex];
              if (page) {
                setPageNameDraft(page.name);
                setEditingPageId(page.id);
              }
            },
          },
          { label: "Duplicate", disabled: false, onSelect: () => void copyPage(pageMenu.pageId) },
          {
            label: "Move up",
            disabled: pageMenuIndex <= 0,
            onSelect: () => movePage(pageMenu.pageId, -1),
          },
          {
            label: "Move down",
            disabled: pageMenuIndex >= pages.length - 1,
            onSelect: () => movePage(pageMenu.pageId, 1),
          },
          {
            label: "Delete page",
            danger: true,
            disabled: pages.length <= 1,
            onSelect: () => void removePage(pageMenu.pageId),
          },
        ]
      : [];
  const pageIcon = (
    <svg
      aria-hidden="true"
      width="14"
      height="16"
      viewBox="0 0 14 16"
      fill="none"
      className="shrink-0 text-secondary-ink"
    >
      <path
        d="M2 1.5h6.5L12 5v9.5H2z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="M8.5 1.5V5H12" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );

  const viewMenu = (
    <CanvasViewMenu
      percent={Math.round(view.zoom * 100)}
      hasSelection={selectedIds.length > 0}
      preferences={viewPreferences}
      nudgeStep={nudgeStep}
      onNudgeStep={updateNudgeStep}
      onToggle={toggleViewPreference}
      onZoom={zoomView}
    />
  );
  const threadControl = agents && (
    <button
      ref={threadButton}
      type="button"
      aria-expanded={threadsOpen}
      aria-controls="file-threads"
      onClick={() => setThreadsOpen((value) => !value)}
      className="h-8 rounded-md border border-primary-grey/80 bg-surface px-2.5 text-xs hover:bg-primary-grey/20"
    >
      Threads
    </button>
  );
  const editorHeader =
    !preview && !local ? (
      <EditorHeader
        threadControl={threadControl}
        user={user}
        fileId={fileId}
        organizationName={organizationName}
        canShare
        collaborators={<CollaboratorAvatars store={room.store} connection={room.connection} />}
        reviewControl={
          githubReviews && viewerId ? (
            <Suspense fallback={null}>
              <EditorReviewControl
                fileId={fileId}
                document={snapshot.content}
                revision={snapshot.revision}
                selectedIds={selectedIds}
                initial={githubReviews}
                viewerId={viewerId}
                canEdit={!readOnly}
                disabled={busy}
                initialReviewId={initialReviewId}
              />
            </Suspense>
          ) : undefined
        }
      />
    ) : null;

  const panelSelect = useEditorEvent(selectNode);
  const panelMenu = useEditorEvent(openNodeMenu);
  const panelMove = useEditorEvent(
    (id: string, target: string, position: "before" | "inside" | "after") =>
      void changeDocument((content) =>
        relocateLayer(content, id, target, position, measuredBoxes()),
      ),
  );
  const panelVisibility = useEditorEvent(
    (id: string) =>
      void changeDocument((content) => ({
        ...content,
        nodes: content.nodes.map((node) =>
          node.id === id ? { ...node, visible: !node.visible } : node,
        ),
      })),
  );
  const panelLock = useEditorEvent(
    (id: string) =>
      void changeDocument((content) => ({
        ...content,
        nodes: content.nodes.map((node) =>
          node.id === id ? { ...node, locked: !node.locked } : node,
        ),
      })),
  );
  const panelPatch = useEditorEvent(patchSelection);
  const panelGoToMaster = useEditorEvent((id: string) => {
    const content = room.getSnapshot().content;
    const master = content.nodes.find((node) => node.id === id);
    if (!master) return;
    if (nodePageId(master) !== currentPageId) switchPage(nodePageId(master));
    selectNode(id);
    if (viewport.current) {
      const position = absoluteNodePosition(content.nodes, id);
      setView(
        fit(
          [{ ...master, box: { ...master.box, ...position } }],
          viewport.current.clientWidth,
          viewport.current.clientHeight,
        ),
      );
    }
  });
  const panelDocument = useEditorEvent(
    (transform: (content: DesignDocument) => DesignDocument, nextSelection?: string) =>
      void changeDocument(transform, nextSelection),
  );
  const panelExport = useEditorEvent((request: ExportRequest) => void exportSelection(request));
  const panelGradient = useEditorEvent((paintId: string | null) => {
    gradientGesture.current = null;
    cropDrag.current = null;
    resize.current = null;
    room.restore();
    setCropId(null);
    setGradientMode(paintId && selected ? { nodeId: selected.id, paintId } : null);
  });
  const panelUpload = useEditorEvent(uploadFillImage);
  const panelReplace = useEditorEvent(() => replaceImageInput.current?.click());
  const panelCrop = useEditorEvent(toggleCrop);
  const panelPrototype = useEditorEvent(togglePrototype);
  const panelClose = useEditorEvent(() => setInspectorDismissed(true));
  const panelAlign = useEditorEvent(
    (axis: Parameters<typeof alignLayers>[2], keyObjectId?: string) =>
      void changeDocument((content) => alignLayers(content, selectedIds, axis, keyObjectId)),
  );
  const panelDistribute = useEditorEvent(
    (axis: "horizontal" | "vertical") =>
      void changeDocument((content) => distributeLayers(content, selectedIds, axis)),
  );
  const panelGroup = useEditorEvent(() => wrapSelection("group"));
  const panelScale = useEditorEvent(
    (factor: number) =>
      void changeDocument((content) => scaleLayers(content, selectedIds, factor, measuredBoxes())),
  );

  return (
    <main className="relative flex h-dvh w-full overflow-hidden bg-surface text-primary-black">
      {!preview && !local && (
        <EditorThumbnail
          fileId={fileId}
          revision={snapshot.revision}
          cacheScope={viewerId}
          getSnapshot={room.getSnapshot}
          enabled={!readOnly && !busy && !uploading && !panning && !drawing && !editingTextId}
        />
      )}
      <input
        ref={replaceImageInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file && selection) void uploadImages([file], selection);
          event.currentTarget.value = "";
        }}
      />
      <input
        ref={imageInput}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length) void uploadImages(files);
          event.currentTarget.value = "";
        }}
      />
      <EditorPanel open={panelsOpen && !prototypeMode} width={256}>
        <aside className="z-10 flex h-full w-64 shrink-0 flex-col border-r border-primary-grey/70 bg-primary-white">
          <div className="editor-panel-heading flex h-16 shrink-0 items-center gap-2 border-b border-primary-grey/70 px-3 text-sm">
            <Link
              href={backHref}
              prefetch={true}
              aria-label="Back to files"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-primary-grey/20"
            >
              <Icon name="back" size={18} />
            </Link>
            <div className="min-w-0 flex-1">{fileHeading}</div>
            {!!artboards.length && (
              <button
                type="button"
                aria-pressed={interactionMode}
                className="rounded-md border border-primary-grey/70 px-2 py-1.5 text-xs hover:bg-primary-grey/20"
                onClick={() => setInteractionMode((value) => !value)}
              >
                Prototype
              </button>
            )}
            <PanelToggle expanded onClick={togglePanels} />
          </div>
          <div
            role="tablist"
            aria-label="File tools"
            className="flex shrink-0 gap-1 border-b border-primary-grey/60 px-3 py-2"
          >
            {(["layers", "tokens"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={sidebarTab === tab}
                aria-controls={`file-${tab}`}
                onClick={() => setSidebarTab(tab)}
                className={`rounded-lg px-3 py-1.5 text-xs capitalize focus-visible:outline-2 focus-visible:outline-primary-orange ${sidebarTab === tab ? "bg-primary-grey/30 text-primary-black" : "text-secondary-ink hover:bg-primary-grey/15"}`}
              >
                {tab === "layers" ? "Layers" : "Tokens"}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`file-${sidebarTab}`} className="min-h-0 flex-1 overflow-auto">
            {sidebarTab === "tokens" ? (
              <fieldset disabled={readOnly}>
                <ColorTokens
                  document={snapshot.content}
                  onChange={(transform) => void changeDocument(transform)}
                />
              </fieldset>
            ) : (
              <>
                <div className="flex items-center justify-between px-4 pb-2 pt-5">
                  <h2 className="text-xs font-medium text-secondary-ink">Pages</h2>
                  {!readOnly && (
                    <button
                      type="button"
                      aria-label="Add page"
                      title="Add page"
                      onClick={() => void createPage()}
                      className="flex h-7 w-7 items-center justify-center rounded-lg text-xl font-light leading-none text-secondary-ink hover:bg-primary-grey/25 focus-visible:outline-2 focus-visible:outline-primary-orange disabled:opacity-40"
                    >
                      +
                    </button>
                  )}
                </div>
                <div className="space-y-0.5 px-2">
                  {pages.map((page) => (
                    <div
                      key={page.id}
                      className={`group flex h-9 items-center rounded-lg ${page.id === currentPageId ? "bg-primary-grey/30" : "hover:bg-primary-grey/20"}`}
                    >
                      {editingPageId === page.id ? (
                        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 text-sm">
                          {pageIcon}
                          <input
                            autoFocus
                            aria-label="Page name"
                            maxLength={120}
                            value={pageNameDraft}
                            onFocus={(event) => event.currentTarget.select()}
                            onChange={(event) => setPageNameDraft(event.target.value)}
                            onBlur={() => renamePage(page.id, pageNameDraft)}
                            onKeyDown={(event) => {
                              event.stopPropagation();
                              if (event.key === "Enter") event.currentTarget.blur();
                              if (event.key === "Escape") {
                                cancelPageEditRef.current = true;
                                event.currentTarget.blur();
                              }
                            }}
                            className="w-full min-w-0 rounded border border-primary-grey bg-surface px-1 outline-none focus:border-primary-orange"
                          />
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => switchPage(page.id)}
                          onDoubleClick={() => {
                            if (!readOnly) {
                              setPageNameDraft(page.name);
                              setEditingPageId(page.id);
                            }
                          }}
                          onContextMenu={(event) => {
                            if (readOnly) return;
                            event.preventDefault();
                            setPageMenu({
                              ...layerMenuPosition(event.clientX, event.clientY, 5),
                              pageId: page.id,
                            });
                          }}
                          aria-current={page.id === currentPageId ? "page" : undefined}
                          className="flex h-full min-w-0 flex-1 items-center gap-2 px-3 text-left text-sm focus-visible:outline-2 focus-visible:outline-primary-orange"
                        >
                          {pageIcon}
                          <span className="truncate">{page.name}</span>
                        </button>
                      )}
                      {!readOnly && (
                        <button
                          type="button"
                          aria-label={`Page options for ${page.name}`}
                          title="Page options"
                          onClick={(event) =>
                            setPageMenu({
                              ...layerMenuPosition(event.clientX, event.clientY, 5),
                              pageId: page.id,
                            })
                          }
                          className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-secondary-ink opacity-0 hover:bg-primary-grey/35 focus:opacity-100 group-hover:opacity-100"
                        >
                          <Icon name="more" size={17} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <div className="mx-4 mt-5 border-t border-primary-grey/70" />
                <div className="flex items-center justify-between px-4 pb-2 pt-5">
                  <h2 className="text-xs font-medium text-secondary-ink">Layers</h2>
                  <span className="text-[11px] text-secondary-ink">{nodes.length || ""}</span>
                </div>
                {(nodes.length > 12 || layerQuery) && (
                  <input
                    aria-label="Search layers"
                    placeholder="Search layers"
                    value={layerQuery}
                    onChange={(event) => setLayerQuery(event.target.value)}
                    className="mx-3 mb-2 w-[calc(100%-1.5rem)] rounded-lg border border-primary-grey bg-surface px-2 py-1.5 text-xs outline-none focus:border-primary-orange"
                  />
                )}
                <div className="px-2 pb-6">
                  <LayerTree
                    readOnly={readOnly}
                    nodes={nodes}
                    selectedIds={selectedIds}
                    query={layerQuery}
                    onSelect={panelSelect}
                    onMenu={panelMenu}
                    onMove={panelMove}
                    onVisibility={panelVisibility}
                    onLock={panelLock}
                  />
                </div>
              </>
            )}
          </div>
          <div className="max-h-[40%] shrink-0 overflow-y-auto overscroll-contain">
            <AssetBrowser
              assets={browserAssets}
              document={snapshot.content}
              disabled={readOnly || uploading}
              onPlace={(asset) => void placeBrowserAsset(asset)}
              more={Boolean(assetCursor)}
              onMore={() => void loadAssets(assetCursor)}
              loading={assetLoading}
              error={assetError}
            />
            {!readOnly && (
              <FontRecovery
                document={snapshot.content}
                onDocument={(update) => void changeDocument(update)}
              />
            )}
            <ImportNotes
              document={snapshot.content}
              readOnly={readOnly}
              onStatus={(key, status) =>
                void changeDocument((content) => setImportNoteStatus(content, key, status))
              }
              onSelect={(id) => {
                const node = snapshot.content.nodes.find((node) => node.id === id);
                if (node) {
                  switchPage(nodePageId(node));
                  selectNode(id);
                }
              }}
            />
            {!readOnly && (
              <ComponentLibraryPanel
                document={snapshot.content}
                fileId={fileId}
                local={local}
                onDocument={changeDocument}
              />
            )}
          </div>
          {panelsOpen && !preview && !local && (
            <div className="shrink-0 border-t border-primary-grey/70 p-3 pl-16">
              <SendFeedback
                showShortcut
                className="flex min-h-9 w-full items-center gap-3 rounded-lg px-2 text-sm text-secondary-ink hover:bg-primary-grey/20 hover:text-primary-black focus-visible:outline-2 focus-visible:outline-primary-orange"
              />
            </div>
          )}
        </aside>
      </EditorPanel>
      <EditorPanel open={panelsOpen && !prototypeMode} width={53}>
        <aside className="editor-tool-rail z-10 h-full w-[53px] shrink-0 border-r border-primary-grey/70 bg-primary-white px-1.5 py-3">
          {toolRail}
        </aside>
      </EditorPanel>
      <div
        ref={attachViewport}
        tabIndex={0}
        aria-label="Design canvas"
        onDragOver={(event) => {
          if (!readOnly && event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={dropImages}
        onPointerMoveCapture={(event) => {
          if (
            preview ||
            (event.target instanceof Element && event.target.closest("[data-canvas-control]"))
          )
            return;
          room.publishPresence({ cursor: worldPoint(event), away: false });
        }}
        onPointerLeave={() => room.publishPresence({ cursor: null }, true)}
        onContextMenu={(event) => {
          if (viewPreferences.rightClickPan) event.preventDefault();
        }}
        onPointerDownCapture={beginSelectedLayersDrag}
        onLostPointerCapture={(event) => {
          if (drag.current?.pointerId === event.pointerId) artworkCancel();
        }}
        onPointerDown={(event) => {
          if (
            (event.target as Element).closest(
              "button, a, input, textarea, select, [data-canvas-control]",
            )
          )
            return;
          beginCanvasGesture(event);
        }}
        onPointerMove={(event) => {
          const moving = drag.current && nodesById.get(drag.current.id);
          if (moving) artworkPointerMove(moving, event);
          if (pan.current || drawingRef.current || marqueeRef.current)
            canvasMoveFrame.schedule(event);
        }}
        onPointerUp={(event) => {
          const moving = drag.current && nodesById.get(drag.current.id);
          if (moving) artworkPointerUp(moving, event);
          else void finishCanvasGesture(event);
        }}
        onPointerCancel={() => {
          canvasMoveFrame.cancel();
          cropDrag.current = null;
          pan.current = null;
          drawingRef.current = null;
          marqueeRef.current = null;
          drag.current = null;
          resize.current = null;
          setSnapGuides([]);
          setSpacingCues([]);
          room.restore();
          room.publishPresence(
            { preview: null, action: isShapeKind(tool) ? "rectangle" : tool },
            true,
          );
          setPanning(false);
          setDrawing(null);
          setMarquee(null);
        }}
        className={`relative min-w-0 flex-1 overflow-hidden touch-none bg-canvas focus:outline-none ${tool === "hand" || spaceHeld ? (panning ? "cursor-grabbing" : "cursor-grab") : tool === "select" ? "cursor-default" : "cursor-crosshair"}`}
      >
        <div style={{ display: "contents", visibility: viewportReady ? "visible" : "hidden" }}>
          {!preview && !local && (
            <div hidden={!viewPreferences.comments}>
              <CanvasComments
                ref={commentsRef}
                fileId={fileId}
                pageId={currentPageId}
                view={view}
                viewport={viewport}
                liveVersion={room.commentsVersion}
                toolbarControls={!prototypeMode ? viewMenu : undefined}
              />
            </div>
          )}
          <div
            style={
              {
                transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
                transformOrigin: "top left",
                "--canvas-zoom": view.zoom,
              } as React.CSSProperties
            }
            className="absolute left-0 top-0"
          >
            <CanvasArtwork
              assetMimeTypes={assetMimeTypes}
              visibleRootIds={visibleRootIds}
              registerElement={registerElement}
              nodesById={renderedById}
              childrenById={children}
              tokens={tokens}
              selectedIds={selectedIds}
              prototypeMode={prototypeMode}
              prototypeArtboardId={prototypeArtboardId}
              cropId={cropping ? cropId : null}
              editingTextId={editingTextId}
              previewAssetUrls={previewAssetUrls}
              onMenu={panelMenu}
              onDoubleClick={artworkDoubleClick}
              onPointerDown={artworkPointerDown}
              onPointerMove={artworkPointerMove}
              onPointerUp={artworkPointerUp}
              onPointerCancel={artworkCancel}
              onTextDraft={artworkTextDraft}
              onTextFinish={artworkTextFinish}
            />
          </div>
          {viewPreferences.guides && !readOnly && !prototypeMode && (
            <CanvasGuides
              guides={pages.find((page) => page.id === currentPageId)?.guides ?? []}
              viewport={viewport}
              view={view}
              snapPixels={viewPreferences.snapPixels}
              onAdd={(axis, position) =>
                void changeDocument((content) =>
                  addGuide(content, currentPageId, { id: crypto.randomUUID(), axis, position }),
                )
              }
              onMove={(id, position) =>
                void changeDocument((content) => moveGuide(content, currentPageId, id, position))
              }
              onRemove={(id) =>
                void changeDocument((content) => removeGuide(content, currentPageId, id))
              }
            />
          )}
          {selected &&
            selectedIds.length === 1 &&
            selected.visible &&
            !isLayerLocked(nodes, selected.id) &&
            !readOnly &&
            !prototypeMode &&
            tool === "select" &&
            !spaceHeld &&
            !editingGradient &&
            vectorMode !== selected?.id && (
              <SelectionHandles
                key={selected.id}
                node={selected}
                parent={nodes.find((node) => node.id === selected.parentId)}
                viewport={viewport}
                view={view}
                snap={viewPreferences.snapPixels}
                snapObjects={viewPreferences.snapObjects}
                crop={cropping}
                onBegin={() => {
                  resize.current = { ids: [selected.id] };
                  room.publishPresence({ action: "resize" }, true);
                }}
                onPreview={(changes) => {
                  const before = room.getSnapshot();
                  const content = previewLayerChanges(before.content, [selected.id], changes);
                  setSnapshot({ ...before, content });
                  room.publishPresence({
                    preview: {
                      nodeId: selected.id,
                      box: content.nodes.find((node) => node.id === selected.id)!.box,
                    },
                  });
                }}
                onCommit={(changes) => {
                  resize.current = null;
                  void changeDocument(
                    (content) => editLayers(content, [selected.id], changes),
                    undefined,
                    undefined,
                    selected.id,
                  );
                }}
                onCancel={() => {
                  resize.current = null;
                  room.restore();
                  room.publishPresence(
                    { preview: null, action: isShapeKind(tool) ? "rectangle" : tool },
                    true,
                  );
                }}
              />
            )}
          {canScaleSelection &&
            !readOnly &&
            !prototypeMode &&
            tool === "select" &&
            !spaceHeld &&
            !editingGradient &&
            vectorMode !== selected?.id && (
              <MultiSelectionHandles
                ids={multiScaleIds}
                viewport={viewport}
                view={view}
                onBegin={() => {
                  multiScaleGesture.current = multiSelectionGesture(multiScaleIds);
                  resize.current = { ids: multiScaleIds };
                  room.publishPresence({ action: "resize" }, true);
                }}
                onScalePreview={(factor) => {
                  const gesture = multiScaleGesture.current;
                  if (!gesture) return;
                  try {
                    const before = room.getSnapshot();
                    setSnapshot({
                      ...before,
                      content: scaleLayers(
                        before.content,
                        gesture.ids,
                        factor,
                        gesture.boxes,
                        true,
                      ),
                    });
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : "Could not scale layers.");
                  }
                }}
                onScaleCommit={(factor) => {
                  const gesture = multiScaleGesture.current ?? multiSelectionGesture(multiScaleIds);
                  multiScaleGesture.current = null;
                  resize.current = null;
                  if (factor === 1) {
                    room.restore();
                    return;
                  }
                  void changeDocument((content) =>
                    scaleLayers(content, gesture.ids, factor, gesture.boxes),
                  );
                }}
                onResizePreview={(handle, delta, centered, aspect) => {
                  const gesture = multiScaleGesture.current;
                  if (!gesture) return;
                  try {
                    const before = room.getSnapshot();
                    const target = multiResizeTarget(gesture, handle, delta, centered, aspect);
                    setSnapshot({
                      ...before,
                      content: resizeSelectedLayers(
                        before.content,
                        gesture.ids,
                        target,
                        gesture.boxes,
                        true,
                      ),
                    });
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : "Could not resize layers.");
                  }
                }}
                onResizeCommit={(handle, delta, centered, aspect) => {
                  const gesture = multiScaleGesture.current ?? multiSelectionGesture(multiScaleIds);
                  multiScaleGesture.current = null;
                  resize.current = null;
                  try {
                    const target = multiResizeTarget(gesture, handle, delta, centered, aspect);
                    void changeDocument((content) =>
                      resizeSelectedLayers(content, gesture.ids, target, gesture.boxes),
                    );
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : "Could not resize layers.");
                    room.restore();
                  }
                }}
                onCancel={() => {
                  multiScaleGesture.current = null;
                  resize.current = null;
                  room.restore();
                  room.publishPresence(
                    { preview: null, action: isShapeKind(tool) ? "rectangle" : tool },
                    true,
                  );
                }}
              />
            )}
          {tool === "pen" && !readOnly && !prototypeMode && (
            <PenEditor
              viewport={viewport}
              nodes={nodes}
              view={view}
              pageId={currentPageId}
              spaceHeld={spaceHeld}
              onFinish={finishPen}
              onCancel={() => setTool("select")}
            />
          )}
          {selected?.vectorPath &&
            vectorMode === selected.id &&
            tool === "select" &&
            !readOnly &&
            !prototypeMode &&
            !spaceHeld &&
            !isLayerLocked(nodes, selected.id) && (
              <VectorEditor
                key={selected.id}
                node={selected}
                viewport={viewport}
                view={view}
                onBegin={() => {
                  vectorGesture.current = {
                    nodeId: selected.id,
                    path: JSON.stringify(
                      room.getSnapshot().content.nodes.find((n) => n.id === selected.id)
                        ?.vectorPath,
                    ),
                  };
                }}
                onPreview={(contours) => {
                  const before = room.getSnapshot(),
                    source = before.content.nodes.find((n) => n.id === selected.id);
                  if (
                    !source?.vectorPath ||
                    isLayerLocked(before.content.nodes, selected.id) ||
                    JSON.stringify(source.vectorPath) !== vectorGesture.current?.path
                  )
                    return;
                  try {
                    setSnapshot({
                      ...before,
                      content: previewLayerChanges(before.content, [selected.id], {
                        vectorPath: {
                          ...source.vectorPath,
                          shape: undefined,
                          contours,
                          d: serializeContours(contours),
                        },
                      }),
                    });
                  } catch (cause) {
                    room.restore();
                    setError(
                      cause instanceof Error ? cause.message : "Could not preview this point edit.",
                    );
                  }
                }}
                onCommit={(contours) => {
                  const expected = vectorGesture.current?.path;
                  vectorGesture.current = null;
                  room.restore();
                  void changeDocument(
                    (content) => {
                      const source = content.nodes.find((n) => n.id === selected.id);
                      if (
                        !source?.vectorPath ||
                        isLayerLocked(content.nodes, selected.id) ||
                        JSON.stringify(source.vectorPath) !== expected
                      )
                        throw new Error("The path changed during this edit. Please try again.");
                      return editLayers(content, [selected.id], {
                        vectorPath: {
                          ...source.vectorPath,
                          shape: undefined,
                          contours,
                          d: serializeContours(contours),
                        },
                      });
                    },
                    undefined,
                    undefined,
                    selected.id,
                  );
                }}
                onCancel={() => {
                  vectorGesture.current = null;
                  room.restore();
                }}
                onExit={() => setVectorMode(null)}
              />
            )}
          {selected &&
            editingGradient &&
            gradientPaint &&
            (gradientPaint.type === "linear" || gradientPaint.type === "radial") &&
            !spaceHeld && (
              <GradientHandles
                key={`${selected.id}:${gradientPaint.id}`}
                node={selected}
                paint={gradientPaint}
                tokens={tokens}
                viewport={viewport}
                view={view}
                onBegin={() => {
                  gradientGesture.current = { nodeId: selected.id, paintId: gradientPaint.id };
                }}
                onPreview={(edit, size) => {
                  gradientGesture.current = {
                    nodeId: selected.id,
                    paintId: gradientPaint.id,
                    edit,
                    size,
                  };
                  const before = room.getSnapshot();
                  setSnapshot({
                    ...before,
                    content: previewGradientDocument(
                      before.content,
                      selected.id,
                      gradientPaint.id,
                      edit,
                      size,
                    ),
                  });
                }}
                onCommit={(edit, size) => {
                  gradientGesture.current = null;
                  void changeDocument(
                    (content) =>
                      editGradientDocument(content, selected.id, gradientPaint.id, edit, size),
                    undefined,
                    undefined,
                    selected.id,
                  );
                }}
                onCancel={() => {
                  gradientGesture.current = null;
                  room.restore();
                }}
                onExit={() => {
                  gradientGesture.current = null;
                  room.restore();
                  setGradientMode(null);
                  viewport.current?.focus();
                }}
              />
            )}
          {viewPreferences.pixelGrid && view.zoom >= 2 && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 z-10"
              style={{
                backgroundImage:
                  "linear-gradient(to right, color-mix(in srgb, var(--color-overlay) 8%, transparent) 1px, transparent 1px), linear-gradient(to bottom, color-mix(in srgb, var(--color-overlay) 8%, transparent) 1px, transparent 1px)",
                backgroundSize: `${view.zoom}px ${view.zoom}px`,
                backgroundPosition: `${view.x}px ${view.y}px`,
              }}
            />
          )}
          {drawing && (
            <div
              aria-hidden="true"
              className={`pointer-events-none absolute ${drawing.shape ? "" : "border-2 border-primary-orange"} ${drawing.shape ? "" : drawing.type === "artboard" ? "bg-document-paper/60" : "bg-primary-orange/15"}`}
              style={{
                left: drawingBox(drawing.start, drawing.end).x * view.zoom + view.x,
                top: drawingBox(drawing.start, drawing.end).y * view.zoom + view.y,
                width: drawingBox(drawing.start, drawing.end).width * view.zoom,
                height: Math.max(1, drawingBox(drawing.start, drawing.end).height) * view.zoom,
                minWidth: view.zoom,
              }}
            >
              {drawing.shape && (
                <DesignImage
                  src=""
                  node={buildNativeShape(
                    "preview",
                    {
                      kind: drawing.shape,
                      reverseX: drawing.end.x < drawing.start.x,
                      reverseY: drawing.end.y < drawing.start.y,
                    },
                    null,
                    {
                      x: 0,
                      y: 0,
                      width: Math.max(1, Math.abs(drawing.end.x - drawing.start.x)),
                      height: Math.max(1, Math.abs(drawing.end.y - drawing.start.y)),
                    },
                  )}
                />
              )}
            </div>
          )}
          {!preview && !local && (
            <CollaboratorOverlay
              store={room.store}
              pageId={currentPageId}
              view={view}
              viewport={viewport}
              document={snapshot.content}
              localSelection={selectedIds}
            />
          )}
          {!inspectorOpen && !prototypeMode && threadControl && (
            <div
              data-canvas-control
              className="absolute right-4 top-4 z-20 rounded-lg bg-surface p-1"
            >
              {threadControl}
            </div>
          )}
          {agents && !prototypeMode && (
            <AgentCursors
              store={room.activities}
              document={snapshot.content}
              pageId={currentPageId}
              view={view}
              viewport={viewport}
              onOpen={(id) => {
                setOpenedThread((previous) => ({ id, version: (previous?.version ?? 0) + 1 }));
                setThreadsOpen(true);
              }}
            />
          )}
          {!preview && !local && !prototypeMode && (
            <AgentActivityOverlay
              panelsOpen={panelsOpen}
              store={room.activities}
              pageId={currentPageId}
              view={view}
              viewport={viewport}
              document={snapshot.content}
              revision={snapshot.revision}
            />
          )}
          {snapGuides.map((guide, index) => (
            <div
              key={index}
              data-snap-guide
              aria-hidden="true"
              className="pointer-events-none absolute z-10 bg-primary-orange"
              style={
                guide.axis === "x"
                  ? {
                      left: guide.position * view.zoom + view.x,
                      top: guide.start * view.zoom + view.y,
                      width: 1,
                      height: (guide.end - guide.start) * view.zoom,
                    }
                  : {
                      left: guide.start * view.zoom + view.x,
                      top: guide.position * view.zoom + view.y,
                      width: (guide.end - guide.start) * view.zoom,
                      height: 1,
                    }
              }
            />
          ))}
          {spacingCues.map((cue, index) => {
            const length = (cue.end - cue.start) * view.zoom;
            return (
              <div
                key={index}
                data-spacing-cue={cue.axis}
                aria-hidden="true"
                className="pointer-events-none absolute z-10 bg-primary-orange"
                style={
                  cue.axis === "x"
                    ? {
                        left: cue.start * view.zoom + view.x,
                        top: cue.cross * view.zoom + view.y,
                        width: length,
                        height: 1,
                      }
                    : {
                        top: cue.start * view.zoom + view.y,
                        left: cue.cross * view.zoom + view.x,
                        height: length,
                        width: 1,
                      }
                }
              >
                {length >= 28 && (
                  <span className="absolute -top-5 left-1/2 -translate-x-1/2 rounded bg-primary-orange px-1 text-[10px] leading-4 text-on-brand">
                    {Math.round(cue.gap * 10) / 10}
                  </span>
                )}
              </div>
            );
          })}
          {!prototypeMode && (preview || local || !viewPreferences.comments) && (
            <div data-canvas-control className="absolute right-4 top-4 z-20">
              {viewMenu}
            </div>
          )}
          {marquee && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute z-10 border border-primary-orange bg-primary-orange/10"
              style={{
                left: Math.min(marquee.start.x, marquee.end.x),
                top: Math.min(marquee.start.y, marquee.end.y),
                width: Math.abs(marquee.end.x - marquee.start.x),
                height: Math.abs(marquee.end.y - marquee.start.y),
              }}
            />
          )}
          <EditorChrome visible={!panelsOpen || prototypeMode}>
            <div
              data-canvas-control
              className="fixed left-3 top-6 z-20 flex max-w-[calc(100%-1.5rem)] min-w-0 items-center gap-2 rounded-lg border border-primary-grey/65 bg-primary-white/95 p-1.5 shadow-sm"
            >
              <Link
                href={backHref}
                prefetch={true}
                aria-label="Back to files"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg hover:bg-primary-grey/20"
              >
                <Icon name="back" />
              </Link>
              <span className="h-6 w-px shrink-0 bg-primary-grey/65" />
              <div className="min-w-0 max-w-44 px-2 text-sm">{fileHeading}</div>
              {!!artboards.length && !prototypeMode && (
                <button
                  type="button"
                  aria-pressed={interactionMode}
                  className="rounded-md border border-primary-grey/70 px-2 py-1.5 text-xs hover:bg-primary-grey/20"
                  onClick={() => setInteractionMode((value) => !value)}
                >
                  Prototype
                </button>
              )}
              {!prototypeMode && <PanelToggle expanded={false} onClick={togglePanels} />}
            </div>
          </EditorChrome>
          <EditorChrome visible={!panelsOpen && !prototypeMode}>
            <div
              data-canvas-control
              className="fixed left-3 top-1/2 z-20 -translate-y-1/2 rounded-lg border border-primary-grey/65 bg-primary-white/95 p-1.5 shadow-sm"
            >
              {toolRail}
            </div>
          </EditorChrome>
          {prototypeMode && (
            <div
              data-canvas-control
              className="absolute inset-0 z-40"
              onPointerDown={(event) => event.stopPropagation()}
            >
              <PrototypePlayer
                document={snapshot.content}
                revision={snapshot.revision}
                fileName={fileName}
                initialFrameId={prototypeArtboardId ?? undefined}
                presentationHref={
                  !local && !preview ? `/present/${encodeURIComponent(fileId)}` : undefined
                }
                onExit={togglePrototype}
              />
            </div>
          )}
          {error && (
            <div
              role="alert"
              className="absolute bottom-4 left-4 z-30 max-w-xs rounded-lg bg-surface p-3 text-xs shadow-sm"
            >
              {error}
            </div>
          )}
        </div>
      </div>
      <EditorPanel open={inspectorOpen} width={296} side="right">
        <aside
          ref={inspectorRef}
          onFocusCapture={(event) => {
            if (
              event.target instanceof HTMLInputElement ||
              event.target instanceof HTMLTextAreaElement ||
              event.target instanceof HTMLSelectElement
            )
              editingRef.current = true;
          }}
          onBlurCapture={() => {
            window.setTimeout(() => {
              const active = document.activeElement;
              editingRef.current = Boolean(
                active &&
                inspectorRef.current?.contains(active) &&
                (active instanceof HTMLInputElement ||
                  active instanceof HTMLTextAreaElement ||
                  active instanceof HTMLSelectElement),
              );
            }, 0);
          }}
          aria-label="Inspector"
          className="z-10 flex h-full w-[296px] shrink-0 flex-col border-l border-primary-grey/70 bg-primary-white text-primary-black"
        >
          {editorHeader && (
            <div className="shrink-0 border-b border-primary-grey/70">{editorHeader}</div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {selected && interactionMode && selectedIds.length === 1 && (
              <PrototypeInspector
                key={selected.id}
                node={selected}
                document={snapshot.content}
                readOnly={readOnly}
                onPatch={panelPatch}
                onPreview={panelPrototype}
              />
            )}
            {selected && !interactionMode && (
              <SelectionInspector
                key={[...selectedIds].sort().join(":")}
                selected={inspectorSelection}
                mode={readOnly ? "inspect" : inspectorMode}
                document={snapshot.content}
                viewport={viewport}
                readOnly={readOnly}
                onPatch={panelPatch}
                onDocument={panelDocument}
                onGoToMaster={panelGoToMaster}
                onExport={panelExport}
                exportPending={exportPending}
                exportWarnings={exportWarnings}
                editingGradientId={editingGradient ? gradientMode?.paintId : undefined}
                onGradientEdit={panelGradient}
                onUploadFill={panelUpload}
                onReplaceImage={panelReplace}
                onCropImage={panelCrop}
                cropping={cropping}
                editingVector={vectorMode === selected.id}
                onEditVector={() =>
                  vectorMode === selected.id ? setVectorMode(null) : beginVectorEditing(selected)
                }
                onPrototype={panelPrototype}
                onClose={!panelsOpen ? panelClose : undefined}
                onAlign={panelAlign}
                onDistribute={panelDistribute}
                onGroup={panelGroup}
                onScale={panelScale}
              />
            )}
          </div>
        </aside>
      </EditorPanel>
      {!preview && !local && (
        <div
          data-canvas-control
          className={`absolute z-30 ${panelsOpen && !prototypeMode ? "bottom-3 left-3" : "bottom-5 left-[72px]"}`}
        >
          <FileVersionControl
            fileId={fileId}
            revision={snapshot.revision}
            canEdit={!readOnly && !prototypeMode}
            disabled={busy || uploading || Boolean(editingTextId)}
            onRestore={restoreFileVersion}
          />
        </div>
      )}
      {!preview && !local && (!panelsOpen || prototypeMode) && (
        <SendFeedback
          compact
          className="absolute bottom-5 left-5 z-30 flex size-10 items-center justify-center rounded-lg border border-primary-grey/70 bg-primary-white text-secondary-ink shadow-sm hover:bg-surface hover:text-primary-black focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-orange active:scale-[0.97]"
        />
      )}
      {agents && threadsOpen && (
        <aside
          id="file-threads"
          aria-label="Threads"
          className="absolute inset-y-0 right-0 z-40 w-full border-l border-primary-grey bg-surface p-4 shadow-sm sm:w-[420px]"
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape") {
              event.preventDefault();
              closeThreads();
            }
          }}
        >
          <ThreadsWorkspace
            key={openedThread?.version ?? fileId}
            {...agents}
            canEdit={!readOnly}
            fileId={fileId}
            selectedNodeIds={selectedIds}
            openThreadId={openedThread?.id}
            onClose={closeThreads}
          />
        </aside>
      )}
      {contextMenu && contextNode && (
        <LayerContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextItems}
          onClose={closeContextMenu}
        />
      )}
      {pageMenu && (
        <LayerContextMenu
          label="Page actions"
          x={pageMenu.x}
          y={pageMenu.y}
          items={pageMenuItems}
          onClose={() => setPageMenu(null)}
        />
      )}
    </main>
  );
}
