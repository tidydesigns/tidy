import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { boundedRequest, withRequestBodyLimit } from "./request-body";

test("Node accepts a wrapped request and preserves its protocol fields and cancellation", async () => {
  const source = await Bun.file(new URL("./request-body.ts", import.meta.url)).text();
  const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;
  const result = spawnSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    const { boundedRequest } = await import(${JSON.stringify(moduleUrl)});
    const controller = new AbortController();
    const original = new Request('https://app.example/api/auth/sign-up/email', {
      method: 'POST', body: JSON.stringify({ accepted: true }),
      headers: { cookie: 'fixture=disposable', 'content-type': 'application/json' },
      cache: 'no-store', credentials: 'include', redirect: 'manual', mode: 'same-origin',
      referrer: 'https://app.example/sign-up', referrerPolicy: 'same-origin', signal: controller.signal
    });
    const wrapped = new Proxy(original, { get(target, key) {
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }});
    const bounded = await boundedRequest(wrapped, 100);
    assert.deepEqual(await bounded.json(), { accepted: true });
    for (const key of ['url','method','cache','credentials','redirect','mode','referrer','referrerPolicy','integrity','keepalive'])
      assert.equal(bounded[key], original[key], key);
    assert.equal(bounded.headers.get('cookie'), 'fixture=disposable');
    controller.abort();
    assert.equal(bounded.signal.aborted, true);
  `,
    ],
    { encoding: "utf8" },
  );
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

function streamed(chunks: string[], headers: Record<string, string> = {}) {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(new TextEncoder().encode(next));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    request: new Request("https://app.example/api/auth/sign-up/email", {
      method: "POST",
      headers,
      body: stream,
      duplex: "half",
    } as RequestInit),
    canceled: () => canceled,
  };
}

for (const headers of [{}, { "content-length": "1" }] as Record<string, string>[]) {
  test(`oversized streamed input never reaches a parser (${JSON.stringify(headers)})`, async () => {
    const source = streamed(["1234", "5678", "9", "never read"], headers);
    let parsed = false;
    const response = await withRequestBodyLimit(async () => {
      parsed = true;
      return Response.json({});
    }, 8)(source.request);
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(parsed).toBe(false);
    expect(source.canceled()).toBe(true);
  });
}

test("byte limits count UTF-8 bytes and preserve exact allowed input and cookies", async () => {
  const request = streamed(["é", "é"], {
    cookie: "session=secret",
    "content-type": "text/plain",
  }).request;
  const result = await boundedRequest(request, 4);
  expect(await result.text()).toBe("éé");
  expect(result.headers.get("cookie")).toBe("session=secret");
  expect(result.method).toBe("POST");
  const response = await withRequestBodyLimit(
    async () => Response.json({}),
    3,
  )(streamed(["éé"]).request);
  expect(response.status).toBe(413);
});

test("multipart form bytes remain parseable after bounding", async () => {
  const form = new FormData();
  form.set("image", new File(["image bytes"], "image.png", { type: "image/png" }));
  const request = new Request("https://app.example/upload", { method: "POST", body: form });
  const image = (await (await boundedRequest(request, 1000)).formData()).get("image");
  expect(image).toBeInstanceOf(File);
  expect(await (image as File).text()).toBe("image bytes");
});

test("invalid length and compressed input fail before parsing", async () => {
  for (const [headers, status] of [
    [{ "content-length": "-1" }, 400],
    [{ "content-encoding": "gzip" }, 415],
  ] as const) {
    let parsed = false;
    const response = await withRequestBodyLimit(async () => {
      parsed = true;
      return Response.json({});
    })(streamed(["x"], headers).request);
    expect(response.status).toBe(status);
    expect(parsed).toBe(false);
  }
});

test("aborting a pending body read cancels it without invoking the handler", async () => {
  const controller = new AbortController();
  let canceled = false;
  const request = new Request("https://app.example/auth", {
    method: "POST",
    signal: controller.signal,
    body: new ReadableStream({
      cancel() {
        canceled = true;
      },
    }),
    duplex: "half",
  } as RequestInit);
  let parsed = false;
  const pending = withRequestBodyLimit(async () => {
    parsed = true;
    return Response.json({});
  })(request);
  controller.abort();
  expect((await pending).status).toBe(408);
  expect(canceled).toBe(true);
  expect(parsed).toBe(false);
});
