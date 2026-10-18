"use client";
import { useEditorHost, type EditorImageProps } from "./host";
export default function EditorImage(props: EditorImageProps) {
  const { Image } = useEditorHost();
  return <Image {...props} />;
}
