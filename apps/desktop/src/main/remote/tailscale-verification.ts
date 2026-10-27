import { z } from "zod";

export const tailscaleVerificationSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.hostname === "login.tailscale.com" &&
        !url.port &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        /^\/a\/[a-zA-Z0-9/_-]+$/.test(url.pathname)
      );
    } catch {
      return false;
    }
  }, "Invalid Tailscale verification address.");

export class VerificationOutput {
  private buffer = "";
  private seen = new Set<string>();
  constructor(private notify: (url: string) => void) {}
  receive(chunk: string) {
    this.buffer = (this.buffer + chunk).slice(-8192);
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      for (const match of line.matchAll(/https:\/\/[^\s<>"']+/g)) {
        const parsed = tailscaleVerificationSchema.safeParse(match[0]);
        if (parsed.success && !this.seen.has(parsed.data)) {
          this.seen.add(parsed.data);
          this.notify(parsed.data);
        }
      }
    }
  }
}
