import { expect, test } from "bun:test";
import { UserFacingError, diagnosticError, errorMessage, handleError } from "@tidy/ui/errors";
import { z } from "zod";
import { readJsonResponse, ResponseError } from "@tidy/editor/lib/http/json-response";

const fallback = "Could not create the file. Please try again.";

test("friendly diagnostic messages preserve the exact original exception and stack", () => {
  const original = new TypeError("Failed to fetch", { cause: new Error("socket closed") });
  const stack = original.stack;
  const reported: unknown[] = [],
    displayed: string[] = [];
  handleError(original, {
    fallback,
    report: (error) => reported.push(error),
    notify: (message) => displayed.push(message),
  });
  expect(reported).toEqual([original]);
  expect(reported[0]).toBe(original);
  expect(original.stack).toBe(stack);
  expect(original.cause).toBeInstanceOf(Error);
  expect(displayed).toEqual(["Could not connect to Tidy. Check your connection and try again."]);
});

test("developer errors, validation payloads and non-Error rejections use fallback copy", () => {
  for (const original of [
    new Error("SELECT secret FROM users"),
    new TypeError("private is not a function"),
    { message: "private response" },
    "private rejection",
    z.string().safeParse(12).error,
  ]) {
    let reported: unknown,
      displayed = "";
    handleError(original, {
      fallback,
      report: (value) => {
        reported = value;
      },
      notify: (value) => {
        displayed = value;
      },
    });
    expect(displayed).toBe(fallback);
    expect(reported).toBe(original);
  }
});

test("custom UI copy unwraps only deliberate display wrappers and preserves the original cause chain", () => {
  const original = new Error("database unavailable", { cause: new Error("connection reset") });
  const wrapper = new UserFacingError("Try again in a moment.", {
    cause: new UserFacingError("Intermediate copy", { cause: original }),
  });
  let reported: unknown;
  expect(
    handleError(wrapper, {
      fallback,
      report: (value) => {
        reported = value;
      },
      notify: () => {},
    }),
  ).toBe("Try again in a moment.");
  expect(reported).toBe(original);
  expect(wrapper.cause).toBeInstanceOf(UserFacingError);
  expect(diagnosticError(wrapper)).toBe(original);
  const cyclic = new UserFacingError("Cycle");
  cyclic.cause = cyclic;
  expect(diagnosticError(cyclic)).toBe(cyclic);
});

test("expected messages do not invent diagnostic exceptions; cancellation is silent", () => {
  const reported: unknown[] = [],
    displayed: string[] = [];
  const handlers = {
    fallback,
    report: (value: unknown) => {
      reported.push(value);
    },
    notify: (value: string) => {
      displayed.push(value);
    },
  };
  handleError(new UserFacingError("Enter a folder name."), handlers);
  expect(displayed).toEqual(["Enter a folder name."]);
  expect(reported).toEqual([]);
  for (const error of [
    new DOMException("cancelled", "AbortError"),
    new UserFacingError("Cancelled", { cause: new DOMException("cancelled", "AbortError") }),
  ])
    expect(handleError(error, handlers)).toBe("");
  expect(displayed).toHaveLength(1);
  expect(reported).toHaveLength(0);
});

test("diagnostic delivery failures cannot hide actionable feedback", () => {
  let displayed = "";
  handleError(new Error("underlying"), {
    fallback,
    report: () => {
      throw new Error("reporter unavailable");
    },
    notify: (value) => {
      displayed = value;
    },
  });
  expect(displayed).toBe(fallback);
});

test("auth code mapping uses reviewed copy and ignores arbitrary messages and inherited keys", () => {
  expect(errorMessage({ code: "INVALID_PASSWORD", message: "private" }, fallback)).toBe(
    "The current password is incorrect.",
  );
  expect(errorMessage({ code: "constructor", message: "private" }, fallback)).toBe(fallback);
  expect(errorMessage(Object.create({ code: "INVALID_PASSWORD" }), fallback)).toBe(fallback);
  expect(errorMessage({ code: "INVALID_TOKEN" }, fallback)).toContain("invalid or expired");
  expect(errorMessage({ code: "INTERNAL_SERVER_ERROR" }, fallback)).toBe(fallback);
});

test("expected auth results stay quiet while technical and wrapped causes remain reportable", () => {
  const captured: unknown[] = [];
  const handlers = { fallback, report: (value: unknown) => captured.push(value), notify: () => {} };
  const expected = { code: "INVALID_EMAIL_OR_PASSWORD", message: "private provider copy" };
  handleError(expected, handlers);
  expect(captured).toEqual([]);
  const original = new Error("connection reset");
  for (const error of [
    { code: "INTERNAL_SERVER_ERROR" },
    Object.assign(new Error("technical failure"), { code: "INVALID_PASSWORD" }),
    { ...expected, cause: original },
  ]) {
    handleError(error, handlers);
    expect(captured.at(-1)).toBe(error);
  }
  handleError(new UserFacingError("Safe copy", { cause: expected }), handlers);
  expect(captured.at(-1)).toBe(expected);
});

test("HTTP failures retain the response and payload without displaying server internals", async () => {
  const response = Response.json({ error: "SQL secret", code: "XX000" }, { status: 503 });
  let caught: unknown;
  try {
    await readJsonResponse({ response, schema: z.unknown(), message: fallback });
  } catch (error) {
    caught = error;
  }
  expect(errorMessage(caught, "other")).toBe(fallback);
  const original = diagnosticError(caught);
  expect(original).toBeInstanceOf(ResponseError);
  expect((original as ResponseError).response).toBe(response);
  expect((original as ResponseError).body).toEqual({ error: "SQL secret", code: "XX000" });
});

test("response validation and JSON parsing keep the diagnostic cause", async () => {
  for (const response of [Response.json({ id: 12 }), new Response("not JSON")]) {
    let caught: unknown;
    try {
      await readJsonResponse({ response, schema: z.object({ id: z.string() }), message: fallback });
    } catch (error) {
      caught = error;
    }
    expect(errorMessage(caught, "other")).toBe(fallback);
    expect(diagnosticError(caught)).toBeInstanceOf(Error);
    expect(diagnosticError(caught)).not.toBe(caught);
  }
  await expect(
    readJsonResponse({
      response: Response.json({ id: "valid" }),
      schema: z.object({ id: z.string() }),
      message: fallback,
    }),
  ).resolves.toEqual({ id: "valid" });
});

test("toast dismissal is scoped and account changes clear queued private messages", async () => {
  const { showToast, dismissToast, clearToasts, toastSnapshot } =
    await import("../../../packages/ui/toast-store");
  clearToasts();
  let dismissed = false;
  const first = showToast("First operation failed.", "error", () => {
    dismissed = true;
  });
  const second = showToast("Second operation failed.");
  expect(showToast("Second operation failed.")).toBe(second);
  expect(toastSnapshot()).toHaveLength(2);
  dismissToast(first, true);
  expect(dismissed).toBe(true);
  expect(toastSnapshot().map((notice) => notice.id)).toEqual([second]);
  clearToasts();
  expect(toastSnapshot()).toEqual([]);
});

test("malformed HTTP responses retain the exact parsing failure, status and response", async () => {
  const original = new SyntaxError("invalid server JSON");
  const response = new Response("invalid", { status: 503 });
  response.json = async () => {
    throw original;
  };
  let caught: unknown;
  try {
    await readJsonResponse({ response, schema: z.unknown(), message: fallback });
  } catch (cause) {
    caught = cause;
  }
  const diagnostic = diagnosticError(caught) as ResponseError;
  expect(diagnostic).toBeInstanceOf(ResponseError);
  expect(diagnostic.response).toBe(response);
  expect(diagnostic.response.status).toBe(503);
  expect(diagnostic.cause).toBe(original);
  expect(errorMessage(caught, "other")).toBe(fallback);
});

test("identical toasts from separate owners can be dismissed independently", async () => {
  const { showToast, dismissToast, clearToasts, toastSnapshot } =
    await import("../../../packages/ui/toast-store");
  clearToasts();
  const firstOwner = {},
    secondOwner = {};
  const shared = showToast("Could not load.");
  const first = showToast("Could not load.", "error", undefined, firstOwner);
  const second = showToast("Could not load.", "error", undefined, secondOwner);
  expect(first).not.toBe(shared);
  expect(second).not.toBe(first);
  expect(showToast("Could not load.", "error", undefined, firstOwner)).toBe(first);
  dismissToast(first);
  expect(toastSnapshot().map((notice) => notice.id)).toEqual([shared, second]);
  clearToasts();
});
