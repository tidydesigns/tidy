import { z } from "zod";
export const BROWSER_CLIPBOARD_LIMIT = 512000;

export const browserScopeSchema = z.object({ projectId: z.uuid(), threadId: z.uuid() }).strict();
export type BrowserScope = z.infer<typeof browserScopeSchema>;
export const browserTabSchema = z.object({
  id: z.uuid(),
  viewId: z.uuid(),
  url: z.string().max(8192),
  title: z.string().max(500),
  loading: z.boolean(),
  error: z.string().nullable(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  width: z.number().int(),
  height: z.number().int(),
});
export const browserStateSchema = z.object({
  keyboardCommands: z.boolean().optional(),
  phase: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("idle") }),
    z.object({ kind: z.literal("installing"), progress: z.number().min(0).max(1) }),
    z.object({ kind: z.literal("starting") }),
    z.object({ kind: z.literal("ready") }),
    z.object({ kind: z.literal("error"), message: z.string() }),
  ]),
  tabs: z.array(browserTabSchema).max(12),
  activeTabId: z.uuid().nullable(),
  control: z.enum(["available", "you", "agent", "another-viewer"]),
  fileChooser: z.object({ id: z.uuid(), tabId: z.uuid(), multiple: z.boolean() }).nullable(),
  downloads: z
    .array(
      z.object({
        id: z.uuid(),
        tabId: z.uuid(),
        name: z.string(),
        size: z.number(),
        status: z.enum(["pending", "ready", "failed"]),
      }),
    )
    .max(12),
  dialog: z
    .object({
      id: z.uuid(),
      type: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
      message: z.string(),
      defaultValue: z.string(),
    })
    .nullable(),
});
export type BrowserState = z.infer<typeof browserStateSchema>;
export const browserQueryActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("download"), tabId: z.uuid(), downloadId: z.uuid() }).strict(),
  z.object({ kind: z.literal("snapshot"), tabId: z.uuid() }).strict(),
  z.object({ kind: z.literal("screenshot"), tabId: z.uuid() }).strict(),
  z.object({ kind: z.literal("console"), tabId: z.uuid() }).strict(),
]);

export const browserActionSchema = z.discriminatedUnion("kind", [
  ...browserQueryActionSchema.options,
  z
    .object({
      kind: z.literal("upload"),
      tabId: z.uuid(),
      chooserId: z.uuid(),
      files: z
        .array(
          z
            .object({
              name: z.string().min(1).max(200),
              data: z
                .string()
                .max(22 * 1024 * 1024)
                .regex(/^[A-Za-z0-9+/]*={0,2}$/),
            })
            .strict(),
        )
        .max(20),
    })
    .strict(),
  z.object({ kind: z.literal("open"), url: z.string().max(8192) }).strict(),
  z.object({ kind: z.literal("navigate"), tabId: z.uuid(), url: z.string().max(8192) }).strict(),
  z.object({ kind: z.literal("select"), tabId: z.uuid() }).strict(),
  z.object({ kind: z.literal("close"), tabId: z.uuid() }).strict(),
  z.object({ kind: z.literal("back"), tabId: z.uuid() }).strict(),
  z.object({ kind: z.literal("forward"), tabId: z.uuid() }).strict(),
  z
    .object({ kind: z.literal("reload"), tabId: z.uuid(), ignoreCache: z.boolean().optional() })
    .strict(),
  z
    .object({
      kind: z.literal("find"),
      tabId: z.uuid(),
      text: z.string().min(1).max(256),
      backwards: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal("stop"), tabId: z.uuid() }).strict(),
  z
    .object({ kind: z.literal("evaluate"), tabId: z.uuid(), expression: z.string().max(32000) })
    .strict(),
  z
    .object({ kind: z.literal("click"), tabId: z.uuid(), selector: z.string().min(1).max(2000) })
    .strict(),
  z
    .object({
      kind: z.literal("fill"),
      tabId: z.uuid(),
      selector: z.string().min(1).max(2000),
      text: z.string().max(32000),
    })
    .strict(),
]);
export type BrowserAction = z.infer<typeof browserActionSchema>;
export const browserCommandSchema = browserScopeSchema
  .extend({ action: browserActionSchema, viewerId: z.uuid().optional() })
  .strict();
export const browserQuerySchema = browserCommandSchema.extend({ action: browserQueryActionSchema });
export function isBrowserQuery(action: BrowserAction) {
  return (
    action.kind === "snapshot" ||
    action.kind === "screenshot" ||
    action.kind === "console" ||
    action.kind === "download"
  );
}
export const browserResultSchema = z.object({
  state: browserStateSchema,
  output: z
    .string()
    .max(22 * 1024 * 1024)
    .optional(),
});
export type BrowserResult = z.infer<typeof browserResultSchema>;
const point = { x: z.number().finite().min(0).max(7680), y: z.number().finite().min(0).max(4320) };
export const browserInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ack"), frameId: z.number().int().positive().safe() }).strict(),
  z.object({ kind: z.literal("take-control") }).strict(),
  z.object({ kind: z.literal("release-control") }).strict(),
  z.object({ kind: z.literal("visibility"), visible: z.boolean() }).strict(),
  z
    .object({
      kind: z.literal("resize"),
      width: z.number().int().min(320).max(2560),
      height: z.number().int().min(240).max(1600),
    })
    .strict(),
  z
    .object({
      kind: z.literal("mouse"),
      action: z.enum(["move", "down", "up"]),
      ...point,
      button: z.enum(["none", "left", "middle", "right"]),
      buttons: z.number().int().min(0).max(7),
      clickCount: z.number().int().min(0).max(3),
      modifiers: z.number().int().min(0).max(15),
    })
    .strict(),
  z
    .object({
      kind: z.literal("wheel"),
      ...point,
      deltaX: z.number().finite().min(-10000).max(10000),
      deltaY: z.number().finite().min(-10000).max(10000),
      modifiers: z.number().int().min(0).max(15),
    })
    .strict(),
  z
    .object({
      kind: z.literal("key"),
      action: z.enum(["down", "up"]),
      key: z.string().max(100),
      code: z.string().max(100),
      keyCode: z.number().int().min(0).max(255),
      text: z.string().max(100),
      command: z
        .enum([
          "moveWordLeft",
          "moveWordLeftAndModifySelection",
          "moveWordRight",
          "moveWordRightAndModifySelection",
          "moveParagraphBackward",
          "moveParagraphBackwardAndModifySelection",
          "moveParagraphForward",
          "moveParagraphForwardAndModifySelection",
          "moveToLeftEndOfLine",
          "moveToLeftEndOfLineAndModifySelection",
          "moveToRightEndOfLine",
          "moveToRightEndOfLineAndModifySelection",
          "moveToBeginningOfDocument",
          "moveToBeginningOfDocumentAndModifySelection",
          "moveToEndOfDocument",
          "moveToEndOfDocumentAndModifySelection",
          "deleteToBeginningOfLine",
          "deleteToEndOfLine",
          "deleteWordBackward",
          "deleteWordForward",
        ])
        .optional(),
      modifiers: z.number().int().min(0).max(15),
    })
    .strict(),
  z.object({ kind: z.literal("text"), text: z.string().max(32000) }).strict(),
  z.object({ kind: z.literal("release-keys") }).strict(),
  z
    .object({
      kind: z.literal("dialog"),
      dialogId: z.uuid(),
      accept: z.boolean(),
      text: z.string().max(4000),
    })
    .strict(),
]);
export type BrowserInput = z.infer<typeof browserInputSchema>;
export const browserInputEnvelopeSchema = z
  .object({
    tabId: z.uuid().nullable(),
    viewId: z.uuid().nullable(),
    input: browserInputSchema,
  })
  .strict();
export type BrowserInputEnvelope = z.infer<typeof browserInputEnvelopeSchema>;
export const browserEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("state"), state: browserStateSchema }),
  z.object({ kind: z.literal("error"), message: z.string() }),
  z.object({ kind: z.literal("disconnected"), message: z.string() }),
]);
export type BrowserEvent = z.infer<typeof browserEventSchema>;
export const browserOutputSchema = z.discriminatedUnion("kind", [
  ...browserEventSchema.options,
  z.object({
    kind: z.literal("frame"),
    tabId: z.uuid(),
    viewId: z.uuid(),
    frameId: z.number().int().positive().safe(),
    data: z
      .instanceof(Uint8Array<ArrayBufferLike>)
      .refine((value) => value.byteLength <= 8 * 1024 * 1024),
  }),
]);
export const browserOutputEnvelopeSchema = z.object({
  watchId: z.uuid(),
  output: browserOutputSchema,
});
export type BrowserOutput = z.infer<typeof browserOutputSchema>;
export type BrowserWatch = { input(input: BrowserInputEnvelope): void; close(): void };
export type BrowserAPI = {
  copy(text: string): Promise<void>;
  download(name: string, base64: string): Promise<void>;
  command(input: z.infer<typeof browserCommandSchema>): Promise<BrowserResult>;
  watch(scope: BrowserScope, receive: (event: BrowserOutput) => void): () => void;
  input(scope: BrowserScope, input: BrowserInputEnvelope): void;
};

export function browserURL(raw: string) {
  const value = raw.trim();
  if (!value) throw new Error("Enter a page address.");
  if (value === "about:blank") return value;
  const url = new URL(
    /^[a-z][a-z\d+.-]*:\/\//i.test(value)
      ? value
      : `${/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(:|\/|$)/i.test(value) ? "http" : "https"}://${value}`,
  );
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Enter an HTTP or HTTPS address without credentials.");
  const normalized = url.toString();
  if (normalized.length > 8192) throw new Error("This page address is too long.");
  return normalized;
}

export const emptyBrowserState: BrowserState = {
  phase: { kind: "idle" },
  tabs: [],
  activeTabId: null,
  control: "available",
  dialog: null,
  fileChooser: null,
  downloads: [],
};

export function isDevelopmentURL(value: string) {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      (url.hostname === "localhost" ||
        url.hostname.endsWith(".localhost") ||
        /^127(?:\.\d{1,3}){3}$/.test(url.hostname) ||
        url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}
