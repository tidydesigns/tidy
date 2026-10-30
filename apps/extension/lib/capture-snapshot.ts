/** Screenshots cannot safely redact overflowing, animated or closed private content.
 * Inspect all roots without layout reads; fail closed if inspection is unavailable.
 */
export function inspectScreenshotPage(
  readShadowRoot: ((element: HTMLElement) => ShadowRoot | null) | undefined,
  observe: (root: Node) => void,
): boolean {
  if (!readShadowRoot || document.designMode?.toLowerCase() === "on") return false;
  const deadline = performance.now() + 25;
  let visited = 0;
  try {
    observe(document);
    const pending: (Element | null)[] = [document.documentElement];
    while (pending.length) {
      const element = pending.pop();
      if (!element) continue;
      if (++visited > 15000 || performance.now() > deadline) return false;
      if (/^(textarea|select|iframe|object|embed)$/i.test(element.localName)) return false;
      // Whitespace makes an input type invalid (and therefore visible); do not trim it.
      if (
        /^input$/i.test(element.localName) &&
        element.getAttribute("type")?.toLowerCase() !== "hidden"
      )
        return false;
      const editable = element.getAttribute("contenteditable")?.toLowerCase();
      if (editable === "" || editable === "true" || editable === "plaintext-only") return false;
      const shadow = element instanceof HTMLElement ? readShadowRoot(element) : element.shadowRoot;
      if (shadow?.mode === "closed") return false;
      if (shadow) {
        observe(shadow);
        pending.push(shadow.firstElementChild);
      }
      pending.push(element.nextElementSibling, element.firstElementChild);
    }
    return true;
  } catch {
    return false;
  }
}

/** Background tabs may never run requestAnimationFrame. Always release the caller. */
export function waitForCapturePaint(timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    let frame = 0;
    const finish = (painted: boolean) => {
      clearTimeout(timer);
      window.cancelAnimationFrame(frame);
      resolve(painted);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => finish(true));
    });
  });
}
