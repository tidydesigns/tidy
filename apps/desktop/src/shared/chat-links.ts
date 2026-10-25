const serviceHosts = {
  "github.com": "github",
  "www.github.com": "github",
  "gist.github.com": "github",
  "gitlab.com": "gitlab",
  "www.gitlab.com": "gitlab",
  "figma.com": "figma",
  "www.figma.com": "figma",
  "notion.so": "notion",
  "www.notion.so": "notion",
  "notion.site": "notion",
  "www.notion.site": "notion",
  "npmjs.com": "npm",
  "www.npmjs.com": "npm",
  "linear.app": "linear",
  "www.linear.app": "linear",
} as const;

export type LinkService = (typeof serviceHosts)[keyof typeof serviceHosts];
export type ChatLink =
  | { kind: "external"; url: string; service: LinkService | null }
  | { kind: "file"; path: string; name: string; line?: number; column?: number };

export function parseChatLink(href: string | undefined): ChatLink | null {
  if (!href || href.length > 4096 || /[\u0000-\u001f\u007f]/.test(href)) return null;
  if (/^(?:https?:|mailto:)/i.test(href)) {
    try {
      const url = new URL(href);
      if (url.username || url.password) return null;
      const service = Object.entries(serviceHosts).find(([host]) => host === url.hostname)?.[1];
      return { kind: "external", url: url.href, service: service ?? null };
    } catch {
      return null;
    }
  }
  let path = href;
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path);
      if (url.hostname && url.hostname !== "localhost") return null;
      if (url.search || url.username || url.password) return null;
      path = url.pathname + url.hash;
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    } catch {
      return null;
    }
  }
  const position = path.match(
    /(?::([1-9]\d*)(?::([1-9]\d*))?|#L([1-9]\d*)(?:C([1-9]\d*))?(?:-L[1-9]\d*)?)$/,
  );
  if (position) path = path.slice(0, position.index);
  if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return null;
  if (/[?#]/.test(path)) return null;
  try {
    path = decodeURIComponent(path).replaceAll("\\", "/");
  } catch {
    return null;
  }
  if (!path || /[\u0000-\u001f\u007f]/.test(path) || path.startsWith("//")) return null;
  const name = path.split("/").at(-1);
  if (
    !name ||
    (!/\.[a-z\d_-]+$/i.test(name) && !/^(?:Dockerfile|Makefile|LICENSE|README)$/i.test(name))
  )
    return null;
  const line = position ? Number(position[1] ?? position[3]) : undefined;
  const column = position?.[2] || position?.[4] ? Number(position[2] ?? position[4]) : undefined;
  if (
    (line !== undefined && !Number.isSafeInteger(line)) ||
    (column !== undefined && !Number.isSafeInteger(column))
  )
    return null;
  return { kind: "file", path, name, ...(line ? { line } : {}), ...(column ? { column } : {}) };
}

export function fileIconName(path: string) {
  const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  if (name === "package.json" || name === "package-lock.json") return "npm";
  if (name === "dockerfile" || name.startsWith("docker-compose.")) return "docker";
  const extension = name.split(".").at(-1);
  switch (extension) {
    case "tsx":
    case "jsx":
      return "react";
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "css":
      return "css";
    case "html":
    case "htm":
      return "html";
    case "svelte":
      return "svelte";
    case "md":
    case "mdx":
      return "markdown";
    case "json":
    case "jsonc":
      return "json";
    case "py":
      return "python";
    default:
      return "file";
  }
}
