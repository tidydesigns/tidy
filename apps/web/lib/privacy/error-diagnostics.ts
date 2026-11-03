const httpStatusMessage = /^HTTP [1-5][0-9]{2}$/;
const nullPropertyMessage = /^Cannot (?:read|set) propert(?:y|ies) of (?:undefined|null)\b/;
const notFunctionMessage = /^.+ is not a function$/;
const notDefinedMessage = /^.+ is not defined$/;
const invalidTypeMessage = /^.+ is not (?:iterable|a constructor)$/;
const chunkLoadMessage =
  /^(?:Loading chunk \S+ failed|Failed to fetch dynamically imported module:)/;
const reactErrorMessage = /^Minified React error #(\d{1,4});/;
const hydrationMessage = /^Hydration failed because/;
const jsonParseMessage = /^(?:Unexpected token|Unexpected end of JSON input|JSON\.parse:)/;
const requestIoMessage = /I\/O.*different request/;
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
  user_action: "Tidy action failed",
  file_create: "Tidy file creation failed",
  file_manage: "Tidy file management failed",
  account_update: "Tidy account update failed",
  integration_update: "Tidy integration update failed",
  clipboard: "Tidy clipboard access failed",
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
      "ResponseError",
      "AggregateError",
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
  if (httpStatusMessage.test(value)) return value;
  // Normalize engine/framework templates instead of transmitting their dynamic
  // property names, identifiers, component text, URLs or serialized values.
  if (nullPropertyMessage.test(value))
    return value.startsWith("Cannot set")
      ? "Cannot set a property of null or undefined"
      : "Cannot read a property of null or undefined";
  if (notFunctionMessage.test(value)) return "Attempted to call a non-function";
  if (notDefinedMessage.test(value)) return "Referenced an undefined variable";
  if (invalidTypeMessage.test(value))
    return value.endsWith("iterable") ? "Value is not iterable" : "Value is not a constructor";
  if (chunkLoadMessage.test(value)) return "Application JavaScript chunk failed to load";
  const react = reactErrorMessage.exec(value);
  if (react) return `Minified React error #${react[1]}`;
  if (hydrationMessage.test(value)) return "React hydration failed";
  if (jsonParseMessage.test(value)) return "Invalid JSON response";
  if (requestIoMessage.test(value)) return "I/O used outside its originating request";
  return diagnosticType(type);
}
