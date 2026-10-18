"use client";

import {
  createContext,
  useContext,
  type AnchorHTMLAttributes,
  type ComponentType,
  type ImgHTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import type { DesignDocument } from "@tidy/design/document";

export type EditorLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  prefetch?: boolean;
  prefetchOnIntent?: boolean;
  onNavigate?: (event: { preventDefault(): void }) => void;
};
export type EditorImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "width" | "height"> & {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  unoptimized?: boolean;
};
export type ThumbnailProps = {
  fileId: string;
  revision: number;
  enabled: boolean;
  cacheScope?: string;
  getSnapshot: () => { revision: number; content: DesignDocument };
};
export type EditorAgentSetup = { resourceUrl: string; organizationId: string };
export type EditorHost = {
  AgentConnection?: ComponentType<{ setup: EditorAgentSetup; open: boolean }>;
  Link: ComponentType<EditorLinkProps>;
  Image: ComponentType<EditorImageProps>;
  Thumbnail?: ComponentType<ThumbnailProps>;
  renameFile(fileId: string, name: string): Promise<{ error?: string }>;
  reportError(operation: string): (error: unknown) => void;
  capture(event: string, properties: Record<string, unknown>): void;
  usePerformance(
    viewport: RefObject<HTMLElement | null>,
    count: number,
    panels: boolean,
    selection: boolean,
  ): void;
};
const defaults: EditorHost = {
  Link: function Link({
    onNavigate,
    prefetch: _prefetch,
    prefetchOnIntent: _intent,
    onClick,
    ...props
  }) {
    return (
      <a
        {...props}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) onNavigate?.(event);
        }}
      />
    );
  },
  Image: function Image({ unoptimized: _unoptimized, ...props }) {
    return <img {...props} />;
  },
  renameFile: async () => ({ error: "File renaming is unavailable." }),
  reportError: () => () => {},
  capture: () => {},
  usePerformance: () => {},
};
const HostContext = createContext(defaults);
export function EditorHostProvider({
  value,
  children,
}: {
  value: Partial<EditorHost>;
  children: ReactNode;
}) {
  return <HostContext.Provider value={{ ...defaults, ...value }}>{children}</HostContext.Provider>;
}
export const useEditorHost = () => useContext(HostContext);
