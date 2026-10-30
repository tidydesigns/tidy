import { z } from "zod";

export const pullRequestStateSchema = z.enum(["open", "draft", "merged", "closed"]);
export type PullRequestState = z.infer<typeof pullRequestStateSchema>;

export function pullRequestURL(href: string | undefined): string | null {
  if (!href || href.length > 4096 || /[\u0000-\u0020\u007f]/.test(href)) return null;
  try {
    const url = new URL(href);
    if (
      url.protocol !== "https:" ||
      !["github.com", "www.github.com"].includes(url.hostname) ||
      url.port ||
      url.username ||
      url.password
    )
      return null;
    const match = url.pathname.match(
      /^\/([a-z\d](?:[a-z\d-]*[a-z\d])?)\/([a-z\d_.-]+)\/pull\/([1-9]\d*)(?:\/(?:files|commits|checks))?\/?$/i,
    );
    if (!match || match[2] === "." || match[2] === ".." || !Number.isSafeInteger(Number(match[3])))
      return null;
    return `https://github.com/${match[1]?.toLowerCase()}/${match[2]?.toLowerCase()}/pull/${match[3]}`;
  } catch {
    return null;
  }
}
