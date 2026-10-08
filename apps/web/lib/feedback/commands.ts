export const OPEN_FEEDBACK_EVENT = "tidy:open-feedback";
export const FEEDBACK_SHORTCUT = "Shift+F";

/** Shared UI command for buttons and the keyboard shortcut. */
export function openFeedback() {
  window.dispatchEvent(new Event(OPEN_FEEDBACK_EVENT));
}

export function isFeedbackShortcut(event: KeyboardEvent) {
  return (
    !event.defaultPrevented &&
    !event.repeat &&
    !event.isComposing &&
    event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    event.key.toLowerCase() === "f"
  );
}
