import { expect, test } from "bun:test";
import { pageRequest } from "./page-request";

test("an unresponsive page cannot keep an import pending indefinitely", async () => {
  await expect(pageRequest(new Promise(() => {}), 5)).rejects.toThrow("stopped responding");
});
test("page responses and failures are preserved", async () => {
  expect(await pageRequest(Promise.resolve({ data: true }), 5)).toEqual({ data: true });
  await expect(pageRequest(Promise.reject(new Error("Document gone")), 5)).rejects.toThrow(
    "Document gone",
  );
});
