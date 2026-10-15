import { expect, mock, test } from "bun:test";
import { healthResponse } from "./health-response";
import { PublicBudgetError } from "./security/public-budget";

const key = new Request("https://app.example/api/health?release=test");
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
