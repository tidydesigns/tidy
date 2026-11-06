import type { Terminal } from "ghostty-web";

/** ghostty-web 0.4 does not forward application mouse events. */
export function installTerminalMouse(terminal: Terminal) {
  let pressed: number | undefined;
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
    const consume = (event: MouseEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const down = (event: MouseEvent) => {
      if (!tracking() || event.shiftKey || event.button > 2) return;
      consume(event);
      terminal.focus();
      terminal.clearSelection();
      pressed = event.button;
      report(event, pressed);
    };
    const move = (event: MouseEvent) => {
      if (pressed === undefined && !element.contains(event.target as Node)) return;
      if (!tracking() || event.shiftKey) return;
      if (!mode(1003) && !(mode(1002) && pressed !== undefined)) return;
      consume(event);
      report(event, (pressed ?? 3) | 32, false, true);
    };
    const up = (event: MouseEvent) => {
      if (pressed === undefined || event.button !== pressed) return;
      const button = pressed;
      pressed = undefined;
      if (!tracking()) return;
      consume(event);
      if (!mode(9)) report(event, button, true);
    };
    const blur = () => {
      pressed = undefined;
      lastMotion = "";
      wheelRemainder = 0;
    };
    const context = (event: MouseEvent) => {
      if (tracking() && !event.shiftKey) consume(event);
    };
    // Register before open so application mouse input precedes local selection/scrollbars.
    element.addEventListener("mousedown", down, true);
    element.addEventListener("contextmenu", context, true);
    element.addEventListener("click", context, true);
    element.addEventListener("dblclick", context, true);
    document.addEventListener("mousemove", move, true);
    document.addEventListener("mouseup", up, true);
    document.defaultView?.addEventListener("blur", blur);
    cleanup = () => {
      element.removeEventListener("mousedown", down, true);
      element.removeEventListener("contextmenu", context, true);
      element.removeEventListener("click", context, true);
      element.removeEventListener("dblclick", context, true);
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mouseup", up, true);
      document.defaultView?.removeEventListener("blur", blur);
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
