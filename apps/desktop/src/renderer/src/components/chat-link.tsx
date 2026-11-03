import { FileNavigationContext } from "../features/repository/file-navigation";
import { FilePrefetchContext } from "../features/repository/file-prefetch";
import { ReferenceIcon } from "./reference-icon";
import { PullRequestIcon } from "./pull-request-icon";
import { pullRequestURL } from "../../../shared/contracts/pull-request";
import { useContext, type ReactNode } from "react";
import { BrowserNavigationContext } from "../features/browser/browser-navigation";
import { isDevelopmentURL } from "../../../shared/contracts/browser";
import { showToast } from "@tidy/ui/toast";
import { fileIconName, parseChatLink } from "../../../shared/models/chat-links";
import type { DesktopAPI } from "../../../shared/contracts/desktop";

export function ChatLink({
  href,
  children,
  api,
  projectId,
  className = "",
}: {
  href?: string;
  children: ReactNode;
  api: Pick<DesktopAPI, "openChatLink" | "browser" | "pullRequestState">;
  projectId: string;
  className?: string;
}) {
  const openFile = useContext(FileNavigationContext);
  const filePrefetch = useContext(FilePrefetchContext);
  const openBrowser = useContext(BrowserNavigationContext);
  const link = parseChatLink(href);
  if (!link || !href) return <span>{children}</span>;
  const file = link.kind === "file";
  const icon = file
    ? fileIconName(link.path)
    : (link.service ?? (link.url.startsWith("mailto:") ? "mail" : "web"));
  const position =
    file && link.line
      ? `:${link.line}${link.column ? `:${link.column}` : ""}${link.endLine ? `-${link.endLine}` : ""}`
      : "";
  const plainLabel = typeof children === "string" ? children : null;
  const pathLabel =
    file &&
    plainLabel !== null &&
    [href, link.path, link.name, `${link.name}:${link.line}`, `${link.name}${position}`].includes(
      plainLabel,
    );
  const prURL = file ? null : pullRequestURL(href);
  const open = () => {
    if (link.kind === "file") {
      if (openFile) openFile(href);
      else showToast("Open this thread to preview its files.");
      return;
    }
    if (link.kind === "external" && api.browser && openBrowser && isDevelopmentURL(link.url)) {
      openBrowser(link.url);
      return;
    }
    void api.openChatLink(projectId, href).catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : "Could not open this link.");
    });
  };
  return (
    <a
      className={`${file ? "chat-file-link" : "chat-web-link"} ${className}`.trim()}
      href={href}
      title={file ? `Open file: ${link.path}${position}` : link.url}
      onPointerEnter={() => {
        if (file && openFile) filePrefetch?.prefetch(href);
      }}
      onFocus={() => {
        if (file && openFile) filePrefetch?.prefetch(href);
      }}
      onClick={(event) => {
        event.preventDefault();
        open();
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        open();
      }}
    >
      {prURL ? (
        <PullRequestIcon url={prURL} api={api} projectId={projectId} />
      ) : (
        icon && <ReferenceIcon name={icon} />
      )}
      <span>{pathLabel ? link.name : children}</span>
      {file && link.line && (
        <span className="chat-link-position">
          · L{link.line}
          {link.endLine ? `-L${link.endLine}` : ""}
          {link.column ? `:C${link.column}` : ""}
        </span>
      )}
    </a>
  );
}
