import { expect, mock, test } from "bun:test";
import { healthResponse } from "./health-response";
import { PublicBudgetError } from "./security/public-budget";

const key = new Request("https://app.example/api/health?release=test");
test.each([true, false])(
  "cached readiness preserves health=%s without more database work",
  async (healthy) => {
    let stored: Response | undefined;
    const cache = {
      match: async () => stored?.clone(),
      put: async (_key: RequestInfo | URL, response: Response) => {
        stored = response;
      },
    };
    const check = mock(async () => {
      if (!healthy) throw new Error("offline");
    });
    const reserve = mock(async () => {});
    for (let i = 0; i < 3; i++) {
      const response = await healthResponse(key, check, reserve, cache);
      expect(response.status).toBe(healthy ? 200 : 503);
      const payload: unknown = await response.json();
      expect(payload).toEqual({ status: healthy ? "ok" : "unavailable" });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-tidy-health-status")).toBeNull();
    }
    expect(check).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(stored?.headers.get("cache-control")).toBe("public, max-age=5");
  },
);

test("cache failure cannot bypass admission or cause a database query after denial", async () => {
  const cache = {
    match: async () => {
      throw new Error("cache offline");
    },
    put: async () => {},
  };
  const check = mock(async () => {});
  const reserve = mock(async () => {
    throw new PublicBudgetError(23);
  });
  const response = await healthResponse(key, check, reserve, cache);
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("23");
  expect(check).not.toHaveBeenCalled();
  const unavailable = await healthResponse(
    key,
    check,
    async () => {
      throw new Error("guard offline");
    },
    cache,
  );
  expect(unavailable.status).toBe(503);
  expect(check).not.toHaveBeenCalled();
});
