import type { RefObject } from "react";
import type { DesignDocument, DesignNode } from "../../design/document";
import type { ExportRequest } from "../../design/export-plan";
import type { Patch } from "../inspector-controls";

export type SelectionInspectorProps = {
  selected: DesignNode[];
  nodesById?: ReadonlyMap<string, DesignNode>;
  mode?: "design" | "inspect";
  document: DesignDocument;
  readOnly?: boolean;
  onPatch: (changes: Patch) => void;
  editingGradientId?: string;
  onGradientEdit?: (id: string | null) => void;
  viewport?: RefObject<HTMLDivElement | null>;
  onDocument: (
    transform: (document: DesignDocument) => DesignDocument,
    nextSelection?: string,
  ) => void;
  onExport: (request: ExportRequest) => void;
  exportPending?: boolean;
  exportWarnings?: string[];
  onReplaceImage: () => void;
  onEditImage?: (paintId?: string) => void;
  onUploadFill?: (index: number, file: File) => Promise<void>;
  onCropImage?: () => void;
  onFitImageBounds?: () => void;
  cropping?: boolean;
  onEditVector?: () => void;
  editingVector?: boolean;
  onGoToMaster?: (id: string) => void;
  onAlign: (
    axis: "left" | "center-x" | "right" | "top" | "center-y" | "bottom",
    keyObjectId?: string,
  ) => void;
  onDistribute: (axis: "horizontal" | "vertical") => void;
  onGroup: () => void;
  onScale?: (factor: number) => void;
};
