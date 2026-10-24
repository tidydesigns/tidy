import { expect, test } from "bun:test";
import { withAuthRequestBodyLimit } from "./request-body";

const jsonContentTypes = [
  "application/json; charset=utf-8",
  "application/vnd.api+json",
  "application/problem+json; charset=utf-8",
  "APPLICATION/LD+JSON; charset=UTF-8",
  // Better Call also treats JSON-prefixed subtypes as JSON.
  "application/json-seq",
];

function registration(input: unknown, contentType = jsonContentTypes[0]) {
  return new Request("https://app.example/api/auth/oauth2/register", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: JSON.stringify(input),
  });
}

test.each(jsonContentTypes)(
  "dense and deeply nested metadata cannot reach validation (%s)",
  async (contentType) => {
    let calls = 0;
    const handle = withAuthRequestBodyLimit(async () => {
      calls++;
      return new Response(null);
    });
    const nested = Array.from({ length: 20 }).reduce<unknown>((child) => ({ child }), 0);
    for (const input of [
      { contacts: Array(5000).fill(0) },
      { metadata: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [i, 0])) },
      { metadata: nested },
    ]) {
      const request = registration(input, contentType);
      expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBeLessThan(65_536);
      const response = await handle(request);
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ error: "invalid_client_metadata" });
    }
    expect(calls).toBe(0);
  },
);

test("registration path aliases retain the metadata admission check", async () => {
  const handle = withAuthRequestBodyLimit(async () => {
    throw new Error("Dense metadata reached provider validation.");
  });
  for (const path of ["/api/auth/oauth2/register/", "/api/auth/oauth2/%72egister"]) {
    const request = registration({ contacts: Array(5000).fill(0) });
    expect((await handle(new Request(`https://app.example${path}`, request))).status).toBe(400);
  }
});

test.each(jsonContentTypes)(
  "normal registration preserves the exact body and headers (%s)",
  async (contentType) => {
    const input = {
      client_name: "Fixture client",
      redirect_uris: ["http://127.0.0.1:12345/callback"],
      token_endpoint_auth_method: "none",
      jwks: { keys: [{ kty: "OKP", crv: "Ed25519", x: "fixture", kid: "1" }] },
    };
    const request = registration(input, contentType);
    const text = await request.clone().text();
    const handle = withAuthRequestBodyLimit(async (bounded) => {
      expect(await bounded.text()).toBe(text);
      expect(bounded.headers.get("content-type")).toBe(contentType);
      return new Response(null, { status: 201 });
    });
    expect((await handle(request)).status).toBe(201);
  },
);

test.each(jsonContentTypes)(
  "byte limits run before metadata inspection or parsing (%s)",
  async (contentType) => {
    let calls = 0;
    const handle = withAuthRequestBodyLimit(async () => {
      calls++;
      return new Response(null);
    });
    expect(
      (await handle(registration({ client_name: "a".repeat(65_536) }, contentType))).status,
    ).toBe(413);
    expect(calls).toBe(0);
  },
);
