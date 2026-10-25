import { memo } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

const plugins = [remarkGfm];

export const MarkdownPreview = memo(function MarkdownPreview({ text }: { text: string }) {
  return (
    <div className="markdown-preview">
      <Markdown
        remarkPlugins={plugins}
        skipHtml
        components={{
          a: ({ children }) => <span>{children}</span>,
          img: ({ alt }) => <span>{alt || "Image"}</span>,
          input: ({ checked }) => <span aria-hidden="true">{checked ? "☑" : "☐"}</span>,
        }}
      >
        {text.slice(0, 4000)}
      </Markdown>
    </div>
  );
});
