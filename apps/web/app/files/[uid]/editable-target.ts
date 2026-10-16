/** Form controls and contenteditable subtrees own their keyboard input. */
export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest("input, textarea, select, [contenteditable]"))
  );
}
