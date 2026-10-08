import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
// Tests intentionally substitute deployment variables.
const testEnvironment: Record<string, string | undefined> = process.env;

mock.module("server-only", () => ({}));
const { authEmailConfigured, sendAuthEmail } = await import("./auth-email");

const originalFetch = globalThis.fetch;
const originalConfig = {
  token: testEnvironment.CLOUDFLARE_EMAIL_API_TOKEN,
  accountId: testEnvironment.CLOUDFLARE_ACCOUNT_ID,
  sender: testEnvironment.AUTH_EMAIL_FROM,
};
let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;

function mockResponse(body: unknown, status = 200) {
  fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(async () => Response.json(body, { status }), {
      preconnect: originalFetch.preconnect,
    }),
  );
  return fetchMock;
}

beforeEach(() => {
  testEnvironment.CLOUDFLARE_EMAIL_API_TOKEN = "test-token";
  testEnvironment.CLOUDFLARE_ACCOUNT_ID = "test-account";
  testEnvironment.AUTH_EMAIL_FROM = "Tidy <accounts@example.test>";
});

afterEach(() => {
  fetchMock?.mockRestore();
  fetchMock = undefined;
  for (const [name, value] of [
    ["CLOUDFLARE_EMAIL_API_TOKEN", originalConfig.token],
    ["CLOUDFLARE_ACCOUNT_ID", originalConfig.accountId],
    ["AUTH_EMAIL_FROM", originalConfig.sender],
  ] as const) {
    if (value === undefined) delete testEnvironment[name];
    else testEnvironment[name] = value;
  }
});

test("Cloudflare auth mail requires all runtime settings", async () => {
  delete testEnvironment.CLOUDFLARE_EMAIL_API_TOKEN;
  expect(authEmailConfigured()).toBe(false);
  await expect(sendAuthEmail("user@example.test", "Reset", "link")).rejects.toThrow(
    "Email delivery is not configured",
  );
  testEnvironment.CLOUDFLARE_EMAIL_API_TOKEN = "test-token";
  delete testEnvironment.CLOUDFLARE_ACCOUNT_ID;
  expect(authEmailConfigured()).toBe(false);
  testEnvironment.CLOUDFLARE_ACCOUNT_ID = "test-account";
  expect(authEmailConfigured()).toBe(true);
});

test("Cloudflare receives the existing named sender and text-only auth message", async () => {
  const fetch = mockResponse({
    success: true,
    result: { delivered: ["user@example.test"], queued: [] },
  });
  await sendAuthEmail("user@example.test", "Reset", "https://example.test/reset?token=secret");
  const [url, options] = fetch.mock.calls[0];
  expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/test-account/email/sending/send");
  expect(options?.method).toBe("POST");
  expect(options?.cache).toBe("no-store");
  expect(options?.headers).toMatchObject({ Authorization: "Bearer test-token" });
  expect(JSON.parse(String(options?.body))).toEqual({
    from: { address: "accounts@example.test", name: "Tidy" },
    to: ["user@example.test"],
    subject: "Reset",
    text: "https://example.test/reset?token=secret",
  });
});

test("Cloudflare queued delivery counts as an accepted send", async () => {
  mockResponse({ success: true, result: { delivered: [], queued: ["USER@example.test"] } });
  await expect(sendAuthEmail("user@example.test", "Reset", "link")).resolves.toBeUndefined();
});

test("Cloudflare rejection, bounce, suppression, and malformed success fail safely", async () => {
  const fetch = mockResponse(
    { success: false, errors: [{ message: "https://example.test/reset?token=secret" }] },
    422,
  );
  for (const [body, status] of [
    [{ success: false }, 422],
    [{ success: false, result: { delivered: ["user@example.test"] } }, 200],
    [{ success: true, result: { permanent_bounces: ["user@example.test"], delivered: [] } }, 200],
    [{ success: true, result: { suppressed_recipients: ["user@example.test"], queued: [] } }, 200],
    [{ success: true, result: { delivered: ["someone-else@example.test"], queued: [] } }, 200],
  ] as const) {
    fetch.mockResolvedValueOnce(Response.json(body, { status }));
    await expect(sendAuthEmail("user@example.test", "Reset", "link")).rejects.toThrow(
      "Could not send the email. Please try again later.",
    );
  }
});

test("a suppressed recipient never reaches the email provider", async () => {
  const budget = await import("./auth/email-budget");
  const reservation = spyOn(budget, "reserveEmailDelivery").mockResolvedValue(false);
  const provider = mockResponse({ success: true, result: { delivered: ["user@example.test"] } });
  try {
    await expect(
      sendAuthEmail("user@example.test", "Verify", "secret-link"),
    ).resolves.toBeUndefined();
    expect(provider).not.toHaveBeenCalled();
  } finally {
    reservation.mockRestore();
  }
});
