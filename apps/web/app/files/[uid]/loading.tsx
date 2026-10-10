import { cookies } from "next/headers";
import { EditorSkeleton } from "@/components/files/editor-skeleton";
import {
  EDITOR_PANELS_COOKIE,
  EDITOR_TOOLBAR_COOKIE,
  editorToolbarPlacement,
} from "@/lib/editor-preferences";

export default async function Loading() {
  const cookieStore = await cookies();
  return (
    <EditorSkeleton
      initialPanelsOpen={cookieStore.get(EDITOR_PANELS_COOKIE)?.value === "open"}
      initialToolbarPlacement={editorToolbarPlacement(
        cookieStore.get(EDITOR_TOOLBAR_COOKIE)?.value,
      )}
    />
  );
}
