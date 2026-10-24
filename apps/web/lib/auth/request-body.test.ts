import { expect, test } from "bun:test";
import { withAuthRequestBodyLimit } from "./request-body";

function registration(input: unknown) {
  return new Request("https://app.example/api/auth/oauth2/register", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(input),
  });
}

test("dense and deeply nested anonymous metadata cannot reach provider validation", async () => {
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
    const request = registration(input);
    expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBeLessThan(65_536);
    const response = await handle(request);
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: "invalid_client_metadata" });
  }
  expect(calls).toBe(0);
});

test("registration path aliases retain the metadata admission check", async () => {
  const handle = withAuthRequestBodyLimit(async () => {
    throw new Error("Dense metadata reached provider validation.");
  });
  for (const path of ["/api/auth/oauth2/register/", "/api/auth/oauth2/%72egister"]) {
    const request = registration({ contacts: Array(5000).fill(0) });
    expect((await handle(new Request(`https://app.example${path}`, request))).status).toBe(400);
  }
});

test("normal client registration preserves the exact body and headers for the provider", async () => {
  const input = {
    client_name: "Fixture client",
    redirect_uris: ["http://127.0.0.1:12345/callback"],
    token_endpoint_auth_method: "none",
    jwks: { keys: [{ kty: "OKP", crv: "Ed25519", x: "fixture", kid: "1" }] },
  };
  const request = registration(input);
  const text = await request.clone().text();
  const handle = withAuthRequestBodyLimit(async (bounded) => {
    expect(await bounded.text()).toBe(text);
    expect(bounded.headers.get("content-type")).toBe("application/json; charset=utf-8");
    return new Response(null, { status: 201 });
  });
  expect((await handle(request)).status).toBe(201);
});

test("the byte limit still runs before metadata inspection or provider parsing", async () => {
  let calls = 0;
  const handle = withAuthRequestBodyLimit(async () => {
    calls++;
    return new Response(null);
  });
  expect((await handle(registration({ client_name: "a".repeat(65_536) }))).status).toBe(413);
  expect(calls).toBe(0);
});
