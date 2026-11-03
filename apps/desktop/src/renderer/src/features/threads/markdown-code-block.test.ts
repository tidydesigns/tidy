import { expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import Markdown from "react-markdown";
import { MarkdownCodeBlock } from "./markdown-code-block";

const components = { pre: MarkdownCodeBlock };

test("only block code gets actions and HTML inside fences stays literal", () => {
  const html = renderToStaticMarkup(
    createElement(Markdown, {
      components,
      skipHtml: true,
      children: 'Inline `code`.\n\n```md\n<script>alert("test")</script>\n```',
    }),
  );
  expect(html.match(/aria-label="Copy code"/g)).toHaveLength(1);
  expect(html).toContain("<code>code</code>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("markdown code");
});

test("copy preserves Markdown verbatim across wrapping and message updates", async () => {
  const window = new Window();
  const globals = new Map<string, PropertyDescriptor | undefined>();
  const writes: string[] = [];
  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    navigator: {
      clipboard: {
        writeText: async (text: string) => {
          writes.push(text);
        },
      },
    },
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const source = "## Context\n\n  - Keep indentation  \n\n```ts\nconst name = 'Éire';\n```\n";
  const render = (text: string) =>
    act(async () =>
      root.render(
        createElement(Markdown, {
          components,
          children: `\`\`\`\`markdown\n${text}\`\`\`\``,
        }),
      ),
    );
  try {
    await render(source);
    const wrap = host.querySelector<HTMLButtonElement>('[aria-label="Disable line wrap"]');
    const copy = host.querySelector<HTMLButtonElement>('[aria-label="Copy code"]');
    if (!wrap || !copy) throw new Error("Code block actions are missing");
    await act(async () => wrap.click());
    expect(wrap.getAttribute("aria-pressed")).toBe("false");
    await act(async () => copy.click());
    expect(writes).toEqual([source]);
    expect(host.querySelector('[aria-label="Copied"]')).not.toBeNull();
    await render(source + "Updated\n");
    await act(async () => copy.click());
    expect(writes.at(-1)).toBe(source + "Updated\n");
    expect(wrap.getAttribute("aria-pressed")).toBe("false");
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.close();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
