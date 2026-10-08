"use client";
import { createContext, useContext, type ReactNode } from "react";
const ImageMimeContext = createContext<Record<string, string>>({});
export function ImageMimeProvider({
  types = {},
  children,
}: {
  types?: Record<string, string>;
  children: ReactNode;
}) {
  return <ImageMimeContext.Provider value={types}>{children}</ImageMimeContext.Provider>;
}
export function useImageMimeType(assetId?: string) {
  const types = useContext(ImageMimeContext);
  return assetId ? types[assetId] : undefined;
}
