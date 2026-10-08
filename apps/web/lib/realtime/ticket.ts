import { z } from "zod";

export const ticketSchema = z
  .object({
    purpose: z.literal("file-room"),
    fileId: z.string().min(1).max(120),
    organizationId: z.string().min(1).max(120),
    userId: z.string().min(1).max(120),
    name: z.string().max(200),
    image: z.string().max(2048).nullable(),
    sessionId: z.string().uuid(),
    authSessionId: z.string().min(1).max(120),
    expiresAt: z.number().int(),
  })
  .strict();
export type RoomTicket = z.infer<typeof ticketSchema>;
const encoder = new TextEncoder();
function encode(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
function decode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid ticket encoding.");
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
    char.charCodeAt(0),
  );
  // Reject alternate strings with nonzero padding bits that decode to the same MAC.
  if (encode(bytes) !== value) throw new Error("Invalid ticket encoding.");
  return bytes;
}
async function key(secret: string) {
  if (secret.length < 32) throw new Error("A configured auth secret is required for live files.");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(`bella-file-room:${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function signTicket(ticket: RoomTicket, secret: string) {
  const payload = encode(encoder.encode(JSON.stringify(ticketSchema.parse(ticket))));
  const signature = await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(payload));
  return `${payload}.${encode(new Uint8Array(signature))}`;
}
export async function verifyTicket(token: string, secret: string): Promise<RoomTicket | null> {
  if (token.length > 6000) return null;
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;
    const [payload, signature] = parts;
    if (
      !payload ||
      !signature ||
      !(await crypto.subtle.verify(
        "HMAC",
        await key(secret),
        decode(signature),
        encoder.encode(payload),
      ))
    )
      return null;
    const ticket = ticketSchema.parse(JSON.parse(new TextDecoder().decode(decode(payload))));
    if (ticket.expiresAt <= Date.now() || ticket.expiresAt > Date.now() + 5 * 60_000 + 5000)
      return null;
    return ticket;
  } catch {
    return null;
  }
}
