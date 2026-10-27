let pending: Promise<typeof import("@tidy/editor")> | undefined;

export function loadCanvasEditor() {
  return (pending ??= import("@tidy/editor").catch((error: unknown) => {
    pending = undefined;
    throw error;
  }));
}
