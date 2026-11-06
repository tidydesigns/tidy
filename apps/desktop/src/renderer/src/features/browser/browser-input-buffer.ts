import type { BrowserInputEnvelope } from "../../../../shared/contracts/browser";
import { coalesceBrowserInput } from "../../../../shared/browser-input";

// Batch high-frequency device events before they cross IPC or a remote socket.
export function createBrowserInputBuffer(options: {
  send(envelope: BrowserInputEnvelope): void;
  schedule(callback: () => void): number;
  cancel(frame: number): void;
}) {
  let pending: BrowserInputEnvelope | undefined;
  let frame: number | undefined;
  const flush = () => {
    if (frame !== undefined) options.cancel(frame);
    frame = undefined;
    const envelope = pending;
    pending = undefined;
    if (envelope) options.send(envelope);
  };
  return {
    send(envelope: BrowserInputEnvelope) {
      const input = envelope.input;
      if (input.kind !== "wheel" && !(input.kind === "mouse" && input.action === "move")) {
        flush();
        options.send(envelope);
        return;
      }
      const merged = pending && coalesceBrowserInput(pending, envelope);
      if (pending && !merged) flush();
      pending = merged ?? envelope;
      if (frame === undefined) frame = options.schedule(flush);
    },
    clear() {
      if (frame !== undefined) options.cancel(frame);
      frame = undefined;
      pending = undefined;
    },
  };
}
