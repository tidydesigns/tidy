import type { Terminal } from "ghostty-web";

/** ghostty-web 0.4 does not forward application mouse events. */
export function installTerminalMouse(terminal: Terminal) {
  let lastMotion = "";
  let wheelRemainder = 0;
  let cleanup = () => {};
  const mode = (value: number) => terminal.wasmTerm?.getMode(value, false) ?? false;
  const tracking = () => terminal.wasmTerm?.hasMouseTracking() ?? false;
  const coordinates = (event: MouseEvent) => {
    const rect = terminal.renderer!.getCanvas().getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const clamp = (value: number, max: number) => Math.max(1, Math.min(max, value));
    return {
      x: clamp(
        Math.floor(((event.clientX - rect.left) / rect.width) * terminal.cols) + 1,
        terminal.cols,
      ),
      y: clamp(
        Math.floor(((event.clientY - rect.top) / rect.height) * terminal.rows) + 1,
        terminal.rows,
      ),
    };
  };
  const encode = (event: MouseEvent, button: number, release = false) => {
    const point = coordinates(event);
    if (!point) return;
    const { x, y } = point;
    const modifiers = (event.altKey ? 8 : 0) | (event.ctrlKey ? 16 : 0);
    const code = button | modifiers;
    let data: string;
    if (mode(1006)) data = `\x1b[<${code};${x};${y}${release ? "m" : "M"}`;
    else {
      const legacy = (release ? 3 : button) | modifiers;
      if (mode(1015)) data = `\x1b[${legacy + 32};${x};${y}M`;
      else {
        // Strings are UTF-8 on the PTY wire: legacy reports must stay ASCII.
        if (!mode(1005) && (x > 95 || y > 95)) return;
        data = `\x1b[M${String.fromCharCode(legacy + 32, x + 32, y + 32)}`;
      }
    }
    return data;
  };
  const report = (event: MouseEvent, button: number, release = false, motion = false) => {
    const data = encode(event, button, release);
    if (!data || (motion && data === lastMotion)) return;
    lastMotion = motion ? data : "";
    terminal.input(data, true);
  };
  terminal.attachCustomWheelEventHandler((event) => {
    if (!tracking()) {
      wheelRemainder = 0;
      return false;
    }
    // Shift is the local selection/scrollback escape hatch while a TUI owns the mouse.
    const height = terminal.renderer!.getCanvas().getBoundingClientRect().height / terminal.rows;
    const lines =
      event.deltaY /
      (event.deltaMode === 0 ? height : event.deltaMode === 2 ? 1 / terminal.rows : 1);
    if (!Number.isFinite(lines)) return true;
    if (event.shiftKey) {
      wheelRemainder = 0;
      terminal.scrollToLine(terminal.viewportY - lines);
      return true;
    }
    if (Math.sign(lines) !== Math.sign(wheelRemainder)) wheelRemainder = 0;
    wheelRemainder += lines;
    const count = Math.min(20, Math.floor(Math.abs(wheelRemainder)));
    if (count) {
      const direction = Math.sign(wheelRemainder);
      wheelRemainder -= direction * count;
      // Bound each event, including very large page/trackpad deltas.
      if (Math.abs(wheelRemainder) >= 1) wheelRemainder %= 1;
      const data = encode(event, direction < 0 ? 64 : 65);
      // One PTY write per wheel event, even when the event spans several lines.
      if (data) terminal.input(data.repeat(count), true);
    }
    return true;
  });
  const open = terminal.open.bind(terminal);
  terminal.open = (element) => {
    const document = element.ownerDocument;
    const lifetime = new AbortController();
    let drag: AbortController | undefined;
    let pressed: number | undefined;
    let lastEvent: MouseEvent | undefined;
    const consume = (event: MouseEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const finishDrag = (event = lastEvent, notify = true) => {
      const button = pressed;
      pressed = undefined;
      drag?.abort();
      drag = undefined;
      if (notify && button !== undefined && event && tracking() && !mode(9))
        report(event, button, true);
      lastMotion = "";
    };
    const move = (event: MouseEvent) => {
      if (!tracking()) return;
      // Ownership is chosen on mouse-down. Releasing Shift during a local
      // selection must not turn it into application input (or vice versa).
      if (pressed === undefined && (event.shiftKey || event.buttons)) return;
      consume(event);
      lastEvent = event;
      if (mode(1003) || (mode(1002) && pressed !== undefined))
        report(event, (pressed ?? 3) | 32, false, true);
    };
    const up = (event: MouseEvent) => {
      if (event.button !== pressed) return;
      consume(event);
      finishDrag(event);
    };
    const down = (event: MouseEvent) => {
      if (!tracking() || event.shiftKey || event.button > 2) return;
      const data = encode(event, event.button);
      if (!data) return;
      consume(event);
      terminal.focus();
      terminal.clearSelection();
      finishDrag();
      pressed = event.button;
      lastEvent = event;
      terminal.input(data, true);
      // Only a live drag needs document-wide capture. Idle terminals have none.
      drag = new AbortController();
      document.addEventListener("mousemove", move, { capture: true, signal: drag.signal });
      document.addEventListener("mouseup", up, { capture: true, signal: drag.signal });
    };
    const blur = () => {
      finishDrag();
      wheelRemainder = 0;
    };
    const context = (event: MouseEvent) => {
      if (tracking() && !event.shiftKey) consume(event);
    };
    // Register before open so application input precedes local selection/scrollbars.
    const options = { capture: true, signal: lifetime.signal };
    element.addEventListener("mousedown", down, options);
    element.addEventListener("mousemove", move, options);
    for (const name of ["contextmenu", "click", "dblclick"] as const)
      element.addEventListener(name, context, options);
    document.defaultView?.addEventListener("blur", blur, { signal: lifetime.signal });
    cleanup = () => {
      finishDrag(undefined, false);
      lifetime.abort();
    };
    try {
      open(element);
    } catch (error) {
      cleanup();
      throw error;
    }
  };
  const dispose = terminal.dispose.bind(terminal);
  terminal.dispose = () => {
    cleanup();
    terminal.attachCustomWheelEventHandler(undefined);
    dispose();
  };
}
