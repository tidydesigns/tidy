import { writeFile } from "node:fs/promises";

const database = new URL(process.env.DATABASE_URL);
if (
  database.hostname !== "127.0.0.1" ||
  database.pathname !== "/tidy_auth_browser_test" ||
  !process.env.AUTH_BROWSER_TEST_INBOX
)
  throw new Error("Auth browser mail requires the disposable test database and inbox.");
const originalFetch = globalThis.fetch;
const deliveries = [];
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (
    url === "https://api.cloudflare.com/client/v4/accounts/auth-browser-test/email/sending/send"
  ) {
    const delivery = JSON.parse(String(init?.body));
    deliveries.push(delivery);
    await writeFile(process.env.AUTH_BROWSER_TEST_INBOX, JSON.stringify(deliveries));
    return Response.json({ success: true, result: { delivered: delivery.to } });
  }
  if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname))
    throw new Error("The auth browser fixture only permits loopback requests and mock mail.");
  return originalFetch(input, init);
};
