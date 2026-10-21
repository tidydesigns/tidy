import { expect, test } from "bun:test";
import { diagnosticMessage, diagnosticType } from "./error-diagnostics";
import { browserExceptions } from "./browser-exceptions";
import { redactTelemetry } from "./telemetry";

const page = "https://app.example/files/private-design?token=secret";
const frame = {
  filename: "https://app.example/_next/static/chunks/editor.js?token=secret",
  lineno: 12,
  colno: 3,
  chunk_id: "00000000-0000-4000-8000-000000000001",
  vars: { password: "secret" },
};
const exception = (value: string, frames = [frame]) => ({
  type: "TypeError",
  value,
  stacktrace: { frames },
});

test("runtime templates retain diagnosis without dynamic customer values", () => {
  for (const [input, expected] of [
    [
      "Cannot read properties of undefined (reading 'private@example.test')",
      "Cannot read a property of null or undefined",
    ],
    ["private design is not a function", "Attempted to call a non-function"],
    ["customerToken is not defined", "Referenced an undefined variable"],
    [
      "Minified React error #418; visit https://react.dev/errors/418?args[]=secret",
      "Minified React error #418",
    ],
    ["Unexpected token 's', secret is not valid JSON", "Invalid JSON response"],
    [
      "Failed to fetch dynamically imported module: https://private.example/?token=secret",
      "Application JavaScript chunk failed to load",
    ],
    ["email=private@example.test password=secret SELECT private FROM users", "TypeError"],
    ['[{"message":"private","path":["secret"]}]', "TypeError"],
    ["Failed to fetch", "Failed to fetch"],
  ])
    expect(diagnosticMessage(input, "TypeError")).toBe(expected);
  expect(diagnosticType("private")).toBe("Error");
  expect(diagnosticType("SecurityError")).toBe("SecurityError");
});

test("shipped dependency failures retain frames and chunk IDs without private data", () => {
  const errors = browserExceptions(
    [exception("Cannot read properties of null (reading 'secret')")],
    page,
  );
  expect(errors[0].value).toBe("Cannot read a property of null or undefined");
  expect(errors[0].stacktrace.frames[0]).toMatchObject({
    filename: frame.filename.split("?")[0],
    chunk_id: frame.chunk_id,
    lineno: 12,
    colno: 3,
  });
  expect(JSON.stringify(errors)).not.toMatch(/secret|private|vars|password/);
});

test.each([undefined, null, "", "privateFunction", { secret: "private-token" }])(
  "serialized browser frames have a redacted function when the SDK supplies %j",
  (functionName) => {
    const input = {
      uuid: "synthetic-event",
      event: "$exception",
      properties: {
        $exception_list: [
          exception("Failed to fetch", [{ ...frame, ...{ function: functionName } }]),
        ],
      },
    };
    const choices = { analytics: false, replay: false, diagnostics: true };
    const result = JSON.parse(JSON.stringify(redactTelemetry(input, choices, page)));
    expect(result.properties.$exception_list[0].stacktrace).toEqual({
      type: "raw",
      frames: [
        {
          filename: frame.filename.split("?")[0],
          function: "<redacted>",
          lineno: 12,
          colno: 3,
          platform: "web:javascript",
          in_app: true,
          chunk_id: frame.chunk_id,
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|password/);
    expect(redactTelemetry(input, { ...choices, diagnostics: false }, page)).toBeNull();
  },
);

test("extension and unrelated scripts do not produce global issues", () => {
  for (const filename of [
    "chrome-extension://private/background.js",
    "moz-extension://private/content.js",
    "https://other.example/script.js",
    page,
  ])
    expect(
      browserExceptions([exception("Failed to fetch", [{ ...frame, filename }])], page),
    ).toEqual([]);
  expect(browserExceptions(undefined, page)).toEqual([]);
});

test("explicit operations retain stackless failures but do not bypass consent or expose properties", () => {
  const input = {
    uuid: "synthetic-event",
    event: "$exception",
    properties: {
      app_error_operation: "file_save",
      $exception_list: [exception("private SQL secret", [])],
      email: "secret",
      $exception_fingerprint: "secret",
    },
  };
  const allowed = { analytics: false, replay: false, diagnostics: true };
  const result = redactTelemetry(input, allowed, page)!;
  expect(result.properties.$exception_list).toMatchObject([
    { value: "Tidy could not persist an edit: TypeError" },
  ]);
  expect(result.properties.app_error_operation).toBe("file_save");
  expect(JSON.stringify(result)).not.toMatch(/secret|SQL|fingerprint/);
  expect(redactTelemetry(input, { ...allowed, diagnostics: false }, page)).toBeNull();
  expect(
    redactTelemetry(
      { ...input, properties: { ...input.properties, app_error_operation: "private" } },
      allowed,
      page,
    ),
  ).toBeNull();
});

test("development chunks with escaped route segments and nearest frames are retained", () => {
  const frames = Array.from({ length: 60 }, (_, i) => ({
    ...frame,
    lineno: i + 1,
    filename: "http://localhost:3000/_next/static/chunks/apps_web_app_files_%5Buid%5D_1iga31r._.js",
  }));
  const result = browserExceptions(
    [exception("Failed to fetch", frames)],
    "http://localhost:3000/files/example",
  );
  expect(result[0].stacktrace.frames).toHaveLength(40);
  expect(result[0].stacktrace.frames.at(-1)?.lineno).toBe(60);
});

test("diagnostics retain replay correlation without enabling replay or analytics", () => {
  const account = { id: "test-account", email: "support@example.test" };
  const event = {
    uuid: "synthetic-event",
    event: "$exception",
    properties: {
      distinct_id: account.id,
      $session_id: "test-session",
      $window_id: "test-window",
      $exception_list: [exception("Failed to fetch")],
    },
  };
  for (const replay of [false, true]) {
    const choices = { analytics: false, replay, diagnostics: true };
    const result = redactTelemetry(event, choices, page, account)!;
    expect(result.properties).toMatchObject({
      distinct_id: account.id,
      $session_id: "test-session",
      $window_id: "test-window",
      $process_person_profile: true,
    });
    expect(
      redactTelemetry(
        { uuid: "synthetic-event", event: "$pageview", properties: {} },
        choices,
        page,
      ),
    ).toBeNull();
    expect(
      Boolean(
        redactTelemetry(
          {
            uuid: "synthetic-event",
            event: "$snapshot",
            properties: { $session_id: "test-session" },
          },
          choices,
          page,
        ),
      ),
    ).toBe(replay);
    expect(redactTelemetry(event, { ...choices, diagnostics: false }, page, account)).toBeNull();
  }
});

test("HTTP diagnostics retain only their numeric status", () => {
  expect(diagnosticMessage("HTTP 503", "ResponseError")).toBe("HTTP 503");
  expect(diagnosticMessage("HTTP 503 private token", "ResponseError")).toBe("ResponseError");
});
