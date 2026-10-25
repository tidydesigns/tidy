/*!
JavaScript logo
The MIT License (MIT)

Copyright (c) 2011 Christopher Williams <chris@iterativedesigns.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/
import type { ReactNode } from "react";
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
import { fileIconName, parseChatLink } from "../../shared/chat-links";
import type { DesktopAPI } from "../../shared/contracts";

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
}: {
  href?: string;
  children: ReactNode;
  api: DesktopAPI;
  projectId: string;
}) {
  const link = parseChatLink(href);
  if (!link || !href) return <span>{children}</span>;
  const file = link.kind === "file";
  const icon = file ? fileIconName(link.path) : link.service;
  const plainLabel = typeof children === "string" ? children : null;
  const pathLabel =
    file &&
    plainLabel !== null &&
    [href, link.path, link.name, `${link.name}:${link.line}`].includes(plainLabel);
  return (
    <a
      className={file ? "chat-file-link" : "chat-web-link"}
      href={href}
      title={file ? `Show in folder: ${link.path}${link.line ? `:${link.line}` : ""}` : link.url}
      onClick={(event) => {
        event.preventDefault();
        void api.openChatLink(projectId, href).catch((error: unknown) => {
          showToast(error instanceof Error ? error.message : "Could not open this link.");
        });
      }}
    >
      {icon && <ReferenceIcon name={icon} />}
      <span>{pathLabel ? link.name : children}</span>
      {file && link.line && <span className="chat-link-position">· L{link.line}</span>}
    </a>
  );
}
