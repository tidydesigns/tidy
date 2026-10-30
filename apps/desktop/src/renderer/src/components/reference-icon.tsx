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

export function ReferenceIcon({
  name,
}: {
  name: keyof typeof icons | "file" | "web" | "video" | "audio" | "image" | "mail";
}) {
  let content: ReactNode;
  switch (name) {
    case "file":
      content = <path d="M14 3H6v18h12V7l-4-4Zm0 0v5h4M9 12h6m-6 4h6" />;
      break;
    case "web":
      content = (
        <>
          <circle cx="12" cy="12" r="9" />
          <ellipse cx="12" cy="12" rx="4" ry="9" />
          <path d="M3 12h18M5 6h14M5 18h14" />
        </>
      );
      break;
    case "video":
      content = (
        <>
          <rect x="3" y="5" width="18" height="14" rx="3" />
          <path d="m10 9 5 3-5 3Z" fill="currentColor" stroke="none" />
        </>
      );
      break;
    case "audio":
      content = (
        <>
          <rect x="3" y="5" width="18" height="14" rx="3" />
          <path d="M7 11v2m3-5v8m4-10v12m3-7v2" />
        </>
      );
      break;
    case "image":
      content = (
        <>
          <rect x="3" y="5" width="18" height="14" rx="3" />
          <circle cx="8" cy="9" r="1" fill="currentColor" stroke="none" />
          <path d="m4 17 5-5 3 3 3-4 5 6" />
        </>
      );
      break;
    case "mail":
      content = (
        <>
          <rect x="3" y="5" width="18" height="14" rx="3" />
          <path d="m4 7 8 6 8-6" />
        </>
      );
      break;
    default:
      content = <path d={icons[name].path} fill="currentColor" stroke="none" />;
  }
  return (
    <svg
      aria-hidden="true"
      className="chat-link-icon"
      data-icon={name}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {content}
    </svg>
  );
}
