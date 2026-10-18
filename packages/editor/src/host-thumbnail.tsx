"use client";
import { useEditorHost, type ThumbnailProps } from "./host";
export function EditorThumbnail(props: ThumbnailProps) {
  const { Thumbnail } = useEditorHost();
  return Thumbnail ? <Thumbnail {...props} /> : null;
}
