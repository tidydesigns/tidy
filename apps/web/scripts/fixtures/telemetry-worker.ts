import { GET, POST } from "../../app/api/t/[...path]/route";

const worker = {
  fetch(request: Request) {
    // This fixture isolates outbound transport; public-budget.worker.test.ts
    // exercises real Durable Object admission and persistence separately.
    Object.assign(globalThis, {
      [Symbol.for("__cloudflare-context__")]: {
        env: {
          BETTER_AUTH_SECRET: "synthetic-transport-budget-secret-at-least-32-characters",
          AUTH_GUARD: {
            idFromName: (name: string) => name,
            get: () => ({
              consume: async () => ({ allowed: true, retryAfter: null, batchSupported: true }),
            }),
          },
        },
      },
    });
    const path = new URL(request.url).pathname.replace("/api/t/", "").split("/");
    return (request.method === "GET" ? GET : POST)(request, {
      params: Promise.resolve({ path }),
    });
  },
};

export default worker;
