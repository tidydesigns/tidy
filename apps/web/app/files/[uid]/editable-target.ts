/** Form controls and contenteditable subtrees own their keyboard input. */
export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target !== null &&
    "closest" in target &&
    typeof target.closest === "function" &&
    Boolean(target.closest("input, textarea, select, [contenteditable]"))
  );
}
