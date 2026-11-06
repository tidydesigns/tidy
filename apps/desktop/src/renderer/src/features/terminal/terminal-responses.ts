import type { ITheme, Terminal } from "ghostty-web";

type State = "ground" | "escape" | "csi" | "osc" | "string" | "osc-escape" | "string-escape";

/**
 * Replies missing from ghostty-web 0.4's WASM build. Keep this deliberately
 * smaller than a VT parser: no screen state, capability guesses or side effects.
 * A bounded streaming scanner avoids replying to query-shaped text inside OSC,
 * DCS, APC, PM or SOS payloads, including across PTY chunk boundaries.
 */
export class TerminalResponses {
  private state: State = "ground";
  private sequence = "";
  private overflow = false;
  private decoder = new TextDecoder();
  constructor(private readonly theme: ITheme) {}

  reset() {
    this.state = "ground";
    this.sequence = "";
    this.overflow = false;
    this.decoder = new TextDecoder();
  }

  write(data: string | Uint8Array): string {
    const text =
      typeof data === "string"
        ? this.decoder.decode() + data
        : this.decoder.decode(data, { stream: true });
    const replies: string[] = [];
    for (let index = 0; index < text.length; index++) {
      // Most output is ordinary text. Skip it without allocating cells or strings.
      if (this.state === "ground") {
        const next = text.indexOf("\x1b", index);
        if (next < 0) break;
        index = next;
        this.state = "escape";
        continue;
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
          if (osc && !this.overflow) replies.push(this.colorReply());
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
          if (!this.overflow) replies.push(this.colorReply());
          this.state = "ground";
        } else if (this.state === "osc") this.collect(char);
        continue;
      }
      if (char === "\x1b") {
        this.state = "escape";
        continue;
      }
      if (this.state === "escape") {
        // C0 controls do not terminate an escape sequence.
        if (char < " " || char === "\x7f") continue;
        this.sequence = "";
        this.overflow = false;
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

  private collect(char: string) {
    if (this.sequence.length < 64 && !this.overflow) this.sequence += char;
    else this.overflow = true;
  }

  private colorReply() {
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
