import { expect, test } from "bun:test";
import { makeSignature } from "better-auth/crypto";
import { verifyConsentQuery } from "./verify-consent-query";

const secret = crypto.randomUUID();
async function signed() {
  const query = new URLSearchParams({
    client_id: "https://client.example/metadata.json",
    exp: String(Math.floor(Date.now() / 1000) + 300),
    redirect_uri: "http://127.0.0.1:1234/callback",
    scope: "mcp:read offline_access",
  });
  query.sort();
  query.set("sig", await makeSignature(query.toString(), secret));
  return query;
}
test("consent uses the provider's canonical signature verifier and refuses tampering", async () => {
  expect(await verifyConsentQuery(await signed(), secret)).toBe(true);
  for (const [name, value] of [
    ["redirect_uri", "https://attacker.example/callback"],
    ["scope", "mcp:read mcp:write"],
    ["exp", "0"],
  ]) {
    const query = await signed();
    query.set(name, value);
    expect(await verifyConsentQuery(query, secret)).toBe(false);
  }
  const duplicate = await signed();
  duplicate.append("sig", duplicate.get("sig")!);
  expect(await verifyConsentQuery(duplicate, secret)).toBe(false);
  expect(await verifyConsentQuery(await signed(), "wrong-secret")).toBe(false);
});
