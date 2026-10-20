import { expect, test } from "bun:test";
import { retryableEditResponse } from "./retryable-edit-response";

test("database connection and transaction failures remain retryable without exposing their payloads", async () => {
  for (const code of ["ECONNRESET", "ETIMEDOUT", "08006", "53300", "57014", "40P01", "40001"]) {
    const error = Object.assign(new Error("private query and connection credentials"), { code });
    const response = retryableEditResponse(new Error("save failed", { cause: error }));
    expect(response?.status).toBe(503);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(await response?.text()).not.toContain("private query");
  }
  expect(retryableEditResponse(new Error("Query read timeout"))?.status).toBe(503);
});

test("conflicts and invalid edits are not turned into indefinite retries", () => {
  for (const error of [
    new Error("This layer or page was deleted elsewhere."),
    new Error("File not found or access denied."),
    Object.assign(new Error("constraint"), { code: "23503" }),
    Object.assign(new Error("duplicate"), { code: "23505" }),
    null,
  ])
    expect(retryableEditResponse(error)).toBeNull();
});
