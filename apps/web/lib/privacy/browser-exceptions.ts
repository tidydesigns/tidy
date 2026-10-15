type Data = Record<string, unknown>;
const object = (value: unknown): Data =>
  value && typeof value === "object" ? (value as Data) : {};

function frameLocation(value: unknown, pageUrl: string) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value, pageUrl);
    // Only shipped application chunks, never document URLs, filesystem paths,
    // extension scripts, customer source files, queries or fragments.
    if (
      url.origin === new URL(pageUrl).origin &&
      /^\/_next\/static\/[\w/.-]+\.m?js$/.test(url.pathname)
    )
      return `${url.origin}${url.pathname}`;
  } catch {
    /* Unknown locations are private. */
  }
}

export function browserExceptions(value: unknown, pageUrl: string) {
  const list = Array.isArray(value) && value.length ? value.slice(0, 3) : [{}];
  return list.map((entry: unknown, index) => {
    const item = object(entry);
    const stack = object(item.stacktrace);
    const mechanism = object(item.mechanism);
    const frames = (Array.isArray(stack.frames) ? stack.frames : []).slice(0, 40).flatMap((raw) => {
      const frame = object(raw);
      const filename = frameLocation(frame.filename, pageUrl);
      if (!filename || !Number.isSafeInteger(frame.lineno) || !Number.isSafeInteger(frame.colno))
        return [];
      return [
        {
          filename,
          lineno: frame.lineno,
          colno: frame.colno,
          platform: "web:javascript",
          in_app: true,
          ...(typeof frame.chunk_id === "string" && /^[\da-f-]{36}$/i.test(frame.chunk_id)
            ? { chunk_id: frame.chunk_id }
            : {}),
        },
      ];
    });
    return {
      type:
        typeof item.type === "string" &&
        ["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError"].includes(item.type)
          ? item.type
          : "Error",
      value: "Application error (message removed for privacy)",
      mechanism: {
        type: ["generic", "onerror", "onunhandledrejection", "console.error"].includes(
          String(mechanism.type),
        )
          ? String(mechanism.type)
          : "generic",
        handled: typeof mechanism.handled === "boolean" ? mechanism.handled : true,
        synthetic: mechanism.synthetic === true,
        exception_id: index,
      },
      stacktrace: { type: "raw", frames },
    };
  });
}
