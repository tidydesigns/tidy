/** Deliberate UI copy shared by native validation and the renderer's safe error mapping. */
export const sessionConflictMessages = {
  settings:
    "This thread still has background work. Keep its current model, effort and permissions to continue, or wait for that work to finish before changing them.",
  context:
    "Wait for background work to finish before changing this conversation's settings, or restore its previous settings to continue.",
} as const;
