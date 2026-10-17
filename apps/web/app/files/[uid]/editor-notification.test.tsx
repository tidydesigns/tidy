import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorNotification } from "./editor-notification";

test("untrusted notification text is escaped and explicitly private for session replay", () => {
  const message = '<img src=x onerror="alert(1)"><script>window.secret</script>';
  const markup = renderToStaticMarkup(
    <EditorNotification message={message} onDismiss={() => {}} />,
  );
  expect(markup).not.toContain("<img");
  expect(markup).not.toContain("<script");
  expect(markup).toContain("&lt;img");
  expect(markup).toContain("&lt;script&gt;");
  expect(markup).toMatch(/<p[^>]*data-ph-private="true"/);
});
