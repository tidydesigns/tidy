const controlCharacterPattern = /[\u0000-\u001f\u007f]/;
const externalSchemePattern = /^(?:https?:|mailto:)/i;
const fileSchemePattern = /^file:/i;
const fileDrivePattern = /^\/[a-z]:\//i;
const filePositionPattern = /(?::(?<colonLine>[1-9]\d*)(?::(?<colonColumn>[1-9]\d*))?(?:-(?<colonEnd>[1-9]\d*))?|#L(?<hashLine>[1-9]\d*)(?:C(?<hashColumn>[1-9]\d*))?(?:-L(?<hashEnd>[1-9]\d*))?)$/;
const schemePattern = /^[a-z][a-z\d+.-]*:/i;
const windowsDrivePattern = /^[a-z]:[\\/]/i;
const queryOrHashPattern = /[?#]/;
const whitespacePattern = /\s/;
const encodedCharacterPattern = /%[a-f\d]{2}/i;
const pathSeparatorPattern = /[\\/]/;

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
  | { kind: "file"; path: string; name: string; line?: number; column?: number; endLine?: number };

export function parseChatLink(href: string | undefined): ChatLink | null {
  if (!href || href.length > 4096 || controlCharacterPattern.test(href)) return null;
  if (externalSchemePattern.test(href)) {
    try {
      const url = new URL(href);
      if (url.username || url.password) return null;
      const service = !url.port
        ? Object.entries(serviceHosts).find(([host]) => host === url.hostname)?.[1]
        : undefined;
      return { kind: "external", url: url.href, service: service ?? null };
    } catch {
      return null;
    }
  }
  let path = href;
  if (fileSchemePattern.test(path)) {
    try {
      const url = new URL(path);
      if (url.hostname && url.hostname !== "localhost") return null;
      if (url.search || url.username || url.password) return null;
      path = url.pathname + url.hash;
      if (fileDrivePattern.test(path)) path = path.slice(1);
    } catch {
      return null;
    }
  }
  const position = path.match(
    filePositionPattern,
  );
  if (position) path = path.slice(0, position.index);
  if (schemePattern.test(path) && !windowsDrivePattern.test(path)) return null;
  if (queryOrHashPattern.test(path) || path.replace(windowsDrivePattern, "").includes(":")) return null;
  try {
    path = decodeURIComponent(path).replaceAll("\\", "/");
  } catch {
    return null;
  }
  if (!path || controlCharacterPattern.test(path) || path.startsWith("//")) return null;
  const name = path.split("/").at(-1);
  if (!name || name === "." || name === "..") return null;
  if (
    !name.includes(".") &&
    whitespacePattern.test(name) &&
    !path.includes("/") &&
    !position &&
    !encodedCharacterPattern.test(href)
  )
    return null;
  const lineText = position?.groups?.colonLine ?? position?.groups?.hashLine;
  const columnText = position?.groups?.colonColumn ?? position?.groups?.hashColumn;
  const endText = position?.groups?.colonEnd ?? position?.groups?.hashEnd;
  const line = lineText ? Number(lineText) : undefined;
  const column = columnText ? Number(columnText) : undefined;
  const endLine = endText ? Number(endText) : undefined;
  if (
    (line !== undefined && !Number.isSafeInteger(line)) ||
    (column !== undefined && !Number.isSafeInteger(column)) ||
    (endLine !== undefined &&
      (!Number.isSafeInteger(endLine) || line === undefined || endLine < line))
  )
    return null;
  return {
    kind: "file",
    path,
    name,
    ...(line ? { line } : {}),
    ...(column ? { column } : {}),
    ...(endLine ? { endLine } : {}),
  };
}

export function fileIconName(path: string) {
  const name = path.split(pathSeparatorPattern).at(-1)?.toLowerCase() ?? "";
  if (name === "package.json" || name === "package-lock.json") return "npm";
  if (name === "dockerfile" || name.startsWith("docker-compose.")) return "docker";
  const extension = name.split(".").at(-1);
  switch (extension) {
    case "mp4":
    case "m4v":
    case "mov":
    case "webm":
    case "mkv":
    case "avi":
    case "mpg":
    case "mpeg":
    case "ogv":
    case "3gp":
    case "3g2":
      return "video";
    case "mp3":
    case "wav":
    case "flac":
    case "aac":
    case "m4a":
    case "ogg":
    case "oga":
    case "opus":
    case "aif":
    case "aiff":
      return "audio";
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "avif":
    case "svg":
    case "ico":
    case "bmp":
    case "tif":
    case "tiff":
    case "heic":
    case "heif":
      return "image";
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
