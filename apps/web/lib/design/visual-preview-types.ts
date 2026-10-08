import type { DesignDocument } from "@bella/design/document";

export type VisualPreviewState = "default" | "hover" | "pressed" | "focus" | "disabled";
export type VisualPreviewView = {
  nodeId: string;
  label: string;
  document: DesignDocument;
  variants: string[];
  initialVariant?: string;
  initialState: VisualPreviewState;
  width: number;
};
export type VisualPreviewData = {
  revision: number;
  views: VisualPreviewView[];
  assets: Record<string, string>;
  warnings: string[];
};
