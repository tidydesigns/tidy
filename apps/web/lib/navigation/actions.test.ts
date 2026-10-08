import { expect, test } from "bun:test";
import { navigateWithFreshSession } from "./actions";

test("session navigation rejects external URLs and browser-normalized escapes before invalidating routes", async () => {
  for (const href of [
    "https://example.invalid",
    "//example.invalid",
    "/\\example.invalid",
    "javascript:alert(1)",
    "/files\n",
    "/files\u0000",
    "files",
    "",
  ]) {
    // The actual Next cache API cannot run outside a request. Receiving this
    // validation error also verifies malformed input never reaches invalidation.
    await expect(navigateWithFreshSession(href)).rejects.toThrow("Invalid navigation destination.");
  }
});
