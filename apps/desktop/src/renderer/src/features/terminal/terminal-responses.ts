import type { ITheme, Terminal } from "ghostty-web";

export const terminalClipboardLimit = 128_000;

type State = "ground" | "escape" | "csi" | "osc" | "string" | "osc-escape" | "string-escape";

/**
 * Replies missing from ghostty-web 0.4's WASM build and optional write-only
 * clipboard handling. This scanner does not maintain screen state.
 * A bounded streaming scanner avoids replying to query-shaped text inside OSC,
 * DCS, APC, PM or SOS payloads, including across PTY chunk boundaries.
 */
export class TerminalResponses {
  private state: State = "ground";
  private sequence = "";
  private overflow = false;
  private decoder?: TextDecoder;
  private sequenceLimit = 64;
  private readonly stringControl = /[\x07\x18\x1a\x1b]/g;
  private liveSequence = true;
  constructor(
    private readonly theme: ITheme,
    private readonly copy?: (text: string) => void,
  ) {}

  reset() {
    this.state = "ground";
    this.sequence = "";
    this.overflow = false;
    this.decoder = undefined;
    this.sequenceLimit = 64;
    this.liveSequence = true;
  }

  write(data: string | Uint8Array, live = true): string {
    if (!live) this.liveSequence = false;
    const text =
      typeof data === "string"
        ? (this.decoder?.decode() ?? "") + data
        : (this.decoder ??= new TextDecoder()).decode(data, { stream: true });
    if (typeof data === "string") this.decoder = undefined;
    const replies: string[] = [];
    for (let index = 0; index < text.length; index++) {
      // Most output is ordinary text. Skip it without allocating cells or strings.
      if (this.state === "ground") {
        const next = text.indexOf("\x1b", index);
        if (next < 0) break;
        index = next;
        this.state = "escape";
        this.liveSequence = live;
        continue;
      }
      // OSC/DCS payloads can be large. Search whole chunks instead of allocating
      // one string per character; discarded payloads stay bounded too.
      if (this.state === "osc" || this.state === "string") {
        this.stringControl.lastIndex = index;
        const end = this.stringControl.exec(text)?.index ?? text.length;
        if (end > index) {
          if (this.state === "osc") this.collect(text.slice(index, end));
          index = end - 1;
          continue;
        }
      }
      const char = text[index];
      if (char === "\x18" || char === "\x1a") {
        this.state = "ground";
        this.sequence = "";
        continue;
      }
      if (this.state === "osc-escape" || this.state === "string-escape") {
        const osc = this.state === "osc-escape";
        if (char === "\\") {
          if (osc && !this.overflow) replies.push(this.oscReply());
          this.state = "ground";
        } else {
          // An embedded escape is payload, never a new query. Discard this OSC.
          this.overflow = true;
          this.state = char === "\x1b" ? this.state : osc ? "osc" : "string";
        }
        continue;
      }
      if (this.state === "osc" || this.state === "string") {
        if (char === "\x1b") this.state = this.state === "osc" ? "osc-escape" : "string-escape";
        else if (this.state === "osc" && char === "\x07") {
          if (!this.overflow) replies.push(this.oscReply());
          this.state = "ground";
        } else if (this.state === "osc") this.collect(char);
        continue;
      }
      if (char === "\x1b") {
        this.state = "escape";
        this.liveSequence = live;
        continue;
      }
      if (this.state === "escape") {
        // C0 controls do not terminate an escape sequence.
        if (char < " " || char === "\x7f") continue;
        this.sequence = "";
        this.overflow = false;
        this.sequenceLimit = 64;
        this.state =
          char === "[" ? "csi" : char === "]" ? "osc" : "PX^_".includes(char) ? "string" : "ground";
        continue;
      }
      if (this.state === "csi") {
        if (char >= "@" && char <= "~") {
          if (char === "c" && !this.overflow) {
            // VT100 with advanced video; no unsupported optional features advertised.
            if (this.sequence === "" || this.sequence === "0") replies.push("\x1b[?1;2c");
            else if (this.sequence === ">" || this.sequence === ">0") replies.push("\x1b[>0;0;0c");
          }
          this.state = "ground";
        } else if (char >= " " && char !== "\x7f") this.collect(char);
      }
    }
    return replies.join("");
  }

  private collect(part: string) {
    if (this.overflow) return;
    // Classify the prefix once; slicing a growing string on every small chunk
    // would repeatedly flatten it and turn fragmented input into quadratic work.
    if (
      this.copy &&
      this.state === "osc" &&
      this.sequence.length < 3 &&
      (this.sequence + part.slice(0, 3)).startsWith("52;")
    )
      this.sequenceLimit = Math.ceil(terminalClipboardLimit / 3) * 4 + 32;
    if (this.sequence.length + part.length <= this.sequenceLimit) this.sequence += part;
    else {
      this.overflow = true;
      this.sequence = "";
    }
  }

  private oscReply() {
    if (this.copy && this.liveSequence && this.sequence.startsWith("52;")) {
      // Write only. Never answer clipboard queries or interpret nested/passthrough OSCs.
      const match = /^52;([cpsq0-7]*);([A-Za-z0-9+/]*={0,2})$/.exec(this.sequence);
      if (match && (!match[1] || /[cs]/.test(match[1]))) {
        try {
          const binary = atob(match[2]);
          if (binary.length <= terminalClipboardLimit) {
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            this.copy(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          }
        } catch {
          // Malformed base64 or UTF-8 is untrusted terminal output, not a UI error.
        }
      }
    }

    const color =
      this.sequence === "10;?"
        ? this.theme.foreground
        : this.sequence === "11;?"
          ? this.theme.background
          : undefined;
    if (!color || !/^#[\da-f]{6}$/i.test(color)) return "";
    // XTerm color replies use 16 bits per component; expand each 8-bit value.
    const rgb = [color.slice(1, 3), color.slice(3, 5), color.slice(5, 7)]
      .map((component) => component.repeat(2))
      .join("/");
    return `\x1b]${this.sequence.slice(0, 2)};rgb:${rgb}\x1b\\`;
  }
}

export function installTerminalResponses(
  terminal: Pick<Terminal, "write" | "reset" | "input"> & {
    options: Pick<Terminal["options"], "theme">;
  },
) {
  const responses = new TerminalResponses(terminal.options.theme);
  const write = terminal.write.bind(terminal);
  terminal.write = (data, callback) => {
    write(data, callback);
    const reply = responses.write(data);
    // Use the same onData path as native replies. TerminalSurface suppresses it
    // during history replay; theme replacements have no input listener yet.
    if (reply) terminal.input(reply, true);
  };
  const reset = terminal.reset.bind(terminal);
  terminal.reset = () => {
    responses.reset();
    reset();
  };
}
