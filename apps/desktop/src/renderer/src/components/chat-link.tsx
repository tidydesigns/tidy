import { VideoPreview } from "./video-preview";
import "./video-preview.css";
import { videoMimeType } from "../../../shared/contracts/video-preview";
import { useContext, useEffect, useState, type ReactNode } from "react";
import { BrowserNavigationContext } from "../features/browser/browser-navigation";
import { isDevelopmentURL } from "../../../shared/contracts/browser";
import {
  siGithub,
  siGitlab,
  siFigma,
  siNotion,
  siNpm,
  siLinear,
  siReact,
  siTypescript,
  siJavascript,
  siCss,
  siHtml5,
  siSvelte,
  siMarkdown,
  siJson,
  siPython,
  siDocker,
} from "simple-icons";
import { showToast } from "@tidy/ui/toast";
import { fileIconName, parseChatLink } from "../../../shared/models/chat-links";
import type { DesktopAPI } from "../../../shared/contracts/desktop";

const icons = {
  github: siGithub,
  gitlab: siGitlab,
  figma: siFigma,
  notion: siNotion,
  npm: siNpm,
  linear: siLinear,
  react: siReact,
  typescript: siTypescript,
  javascript: siJavascript,
  css: siCss,
  html: siHtml5,
  svelte: siSvelte,
  markdown: siMarkdown,
  json: siJson,
  python: siPython,
  docker: siDocker,
};

function ReferenceIcon({ name }: { name: keyof typeof icons | "file" }) {
  return (
    <svg aria-hidden="true" className="chat-link-icon" data-icon={name} viewBox="0 0 24 24">
      {name === "file" ? (
        <path
          d="M14 3H6v18h12V7l-4-4Zm0 0v5h4M9 12h6m-6 4h6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      ) : (
        <path d={icons[name].path} fill="currentColor" />
      )}
    </svg>
  );
}

export function ChatLink({
  href,
  children,
  api,
  projectId,
  threadId,
  active = true,
}: {
  href?: string;
  children: ReactNode;
  api: DesktopAPI;
  projectId: string;
  threadId?: string;
  active?: boolean;
}) {
  const [preview, setPreview] = useState(false);
  useEffect(() => {
    if (!active) setPreview(false);
  }, [active]);
  const openBrowser = useContext(BrowserNavigationContext);
  const link = parseChatLink(href);
  if (!link || !href) return <span>{children}</span>;
  const file = link.kind === "file";
  const video = file && threadId && videoMimeType(link.path);
  const icon = file ? fileIconName(link.path) : link.service;
  const plainLabel = typeof children === "string" ? children : null;
  const pathLabel =
    file &&
    plainLabel !== null &&
    [href, link.path, link.name, `${link.name}:${link.line}`].includes(plainLabel);
  return (
    <>
      <a
        className={file ? "chat-file-link" : "chat-web-link"}
        href={href}
        title={
          video
            ? `Preview video: ${link.path}`
            : file
              ? `Show in folder: ${link.path}${link.line ? `:${link.line}` : ""}`
              : link.url
        }
        onClick={(event) => {
          event.preventDefault();
          if (video) {
            setPreview(true);
            return;
          }
          if (
            link.kind === "external" &&
            api.browser &&
            openBrowser &&
            isDevelopmentURL(link.url)
          ) {
            openBrowser(link.url);
            return;
          }
          void api.openChatLink(projectId, href).catch((error: unknown) => {
            showToast(error instanceof Error ? error.message : "Could not open this link.");
          });
        }}
      >
        {video ? (
          <svg
            aria-hidden="true"
            className="chat-link-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <path d="m10 9 5 3-5 3V9Z" strokeLinejoin="round" />
          </svg>
        ) : (
          icon && <ReferenceIcon name={icon} />
        )}
        <span>{pathLabel ? link.name : children}</span>
        {file && link.line && <span className="chat-link-position">· L{link.line}</span>}
      </a>
      {preview && active && file && threadId && (
        <VideoPreview
          api={api}
          input={{ projectId, threadId, href }}
          name={link.name}
          onClose={() => setPreview(false)}
        />
      )}
    </>
  );
}
