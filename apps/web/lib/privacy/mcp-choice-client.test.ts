import { afterEach, expect, spyOn, test } from "bun:test";
import { diagnosticError } from "@tidy/ui/errors";
import { ResponseError } from "@/lib/http/json-response";
import { loadMcpChoice, recordMcpChoice } from "./mcp-choice-client";

let transport: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;
afterEach(() => transport?.mockRestore());

test("MCP privacy failures retain their response and original parse exception", async () => {
  const original = new SyntaxError("private malformed response");
  const response = new Response("invalid JSON", { status: 503 });
  response.json = async () => {
    throw original;
  };
  transport = spyOn(globalThis, "fetch").mockResolvedValue(response);
  let caught: unknown;
  try {
    await recordMcpChoice(false);
  } catch (cause) {
    caught = cause;
  }
  const diagnostic = diagnosticError(caught) as ResponseError;
  expect(diagnostic.response).toBe(response);
  expect(diagnostic.response.status).toBe(503);
  expect(diagnostic.cause).toBe(original);
});

test("MCP privacy transport failures retain exact identity", async () => {
  const original = new TypeError("Failed to fetch", { cause: new Error("socket closed") });
  transport = spyOn(globalThis, "fetch").mockRejectedValue(original);
  await expect(recordMcpChoice(true)).rejects.toBe(original);
});

test("loading a pending signed-in MCP choice still applies it with the guarded POST", async () => {
  transport = spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ enabled: false, signedIn: true, pending: true }))
    .mockResolvedValueOnce(Response.json({ enabled: true, signedIn: true, pending: false }));
  await expect(loadMcpChoice()).resolves.toEqual({ enabled: true, signedIn: true, pending: false });
  expect(transport.mock.calls).toHaveLength(2);
  const request = transport.mock.calls[1]?.[1];
  expect(request?.method).toBe("POST");
  expect(request?.headers).toEqual({
    "Content-Type": "application/json",
    "x-tidy-privacy": "1",
  });
  expect(JSON.parse(String(request?.body))).toEqual({ applyPending: true });
});
