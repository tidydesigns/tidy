"use client";
import { useEditorHost, type EditorLinkProps } from "./host";
export function NavigationLink(props: EditorLinkProps) {
  const { Link } = useEditorHost();
  return <Link {...props} />;
}
