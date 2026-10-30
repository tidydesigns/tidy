import { expect, test } from "bun:test";
import { mcp } from "@better-auth/mcp";
import type { OAuthClientResource, OAuthResource } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins";

const resource = "http://localhost:3000/api/mcp";

function provider(resources: OAuthResource[] = []) {
  const bindings: OAuthClientResource[] = [];
  const records = {
    user: [],
    session: [],
    account: [],
    verification: [],
    jwks: [],
    oauthResource: resources,
    oauthClient: [],
    oauthClientResource: bindings,
  };
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "disposable-resource-test-secret-at-least-32-characters",
    database: memoryAdapter(records),
    advanced: { database: { validateSchema: false } },
    plugins: [
      jwt(),
      mcp({
        resource,
        loginPage: "/login",
        consentPage: "/mcp/consent",
        scopes: ["openid", "mcp:read"],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
      }),
    ],
  });
  return { auth, records };
}

function registrationRequest() {
  return new Request("http://localhost:3000/api/auth/oauth2/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Resource fixture",
      redirect_uris: ["https://client.example.test/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
}

test("client registration seeds and checks its resource on first use", async () => {
  const { auth, records } = provider();
  await auth.$context;
  expect(records.oauthResource).toHaveLength(0);

  const response = await auth.handler(registrationRequest());
  expect(response.status).toBe(201);
  expect(records.oauthResource).toEqual([
    expect.objectContaining({ identifier: resource, disabled: false }),
  ]);
  expect(records.oauthClientResource).toEqual([expect.objectContaining({ resourceId: resource })]);
});

test("lazy resource seeding preserves disabled resources and rejects registration", async () => {
  const { auth, records } = provider([
    {
      id: "disabled-resource",
      identifier: resource,
      name: "Disabled resource",
      disabled: true,
      policyVersion: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ]);

  const response = await auth.handler(registrationRequest());
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "invalid_target" });
  expect(records.oauthResource).toEqual([
    expect.objectContaining({ identifier: resource, disabled: true }),
  ]);
  expect(records.oauthClient).toHaveLength(0);
  expect(records.oauthClientResource).toHaveLength(0);
});
