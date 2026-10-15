// Only reviewed technical text crosses the telemetry boundary. Arbitrary error
// strings can contain designs, SQL, tokens or provider response bodies.
const messages = new Set([
  "Failed to fetch",
  "Load failed",
  "NetworkError when attempting to fetch resource.",
  "Maximum call stack size exceeded",
  "Too much recursion",
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop limit exceeded",
  "Server unavailable",
  "Could not synchronize file.",
  "Could not apply edit.",
  "File connection is unavailable.",
  "Could not import this Figma file.",
  "Could not read this Figma file.",
  "Could not load assets.",
  "Could not upload image.",
  "Could not restore this version.",
]);

export const appErrorOperations = {
  page_render: "Tidy page rendering failed",
  figma_import: "Tidy Figma import failed",
  file_sync: "Tidy file synchronization failed",
  file_save: "Tidy could not persist an edit",
  sign_in: "Tidy sign-in request failed",
} as const;
export type AppErrorOperation = keyof typeof appErrorOperations;

export function appErrorOperation(value: unknown): AppErrorOperation | undefined {
  return typeof value === "string" && Object.hasOwn(appErrorOperations, value)
    ? (value as AppErrorOperation)
    : undefined;
}

export function diagnosticType(value: unknown): string {
  return typeof value === "string" &&
    [
      "Error",
      "TypeError",
      "RangeError",
      "ReferenceError",
      "SyntaxError",
      "DOMException",
      "SecurityError",
      "InvalidStateError",
      "QuotaExceededError",
      "NotSupportedError",
      "DataCloneError",
      "TimeoutError",
      "AbortError",
    ].includes(value)
    ? value
    : "Error";
}

export function diagnosticMessage(value: unknown, type: string): string {
  if (typeof value !== "string" || value.length > 4096) return diagnosticType(type);
  if (messages.has(value)) return value;
  // Normalize engine/framework templates instead of transmitting their dynamic
  // property names, identifiers, component text, URLs or serialized values.
  if (/^Cannot (?:read|set) propert(?:y|ies) of (?:undefined|null)\b/.test(value))
    return value.startsWith("Cannot set")
      ? "Cannot set a property of null or undefined"
      : "Cannot read a property of null or undefined";
  if (/^.+ is not a function$/.test(value)) return "Attempted to call a non-function";
  if (/^.+ is not defined$/.test(value)) return "Referenced an undefined variable";
  if (/^.+ is not (?:iterable|a constructor)$/.test(value))
    return value.endsWith("iterable") ? "Value is not iterable" : "Value is not a constructor";
  if (/^(?:Loading chunk \S+ failed|Failed to fetch dynamically imported module:)/.test(value))
    return "Application JavaScript chunk failed to load";
  const react = /^Minified React error #(\d{1,4});/.exec(value);
  if (react) return `Minified React error #${react[1]}`;
  if (/^Hydration failed because/.test(value)) return "React hydration failed";
  if (/^(?:Unexpected token|Unexpected end of JSON input|JSON\.parse:)/.test(value))
    return "Invalid JSON response";
  if (/I\/O.*different request/.test(value)) return "I/O used outside its originating request";
  return diagnosticType(type);
}
