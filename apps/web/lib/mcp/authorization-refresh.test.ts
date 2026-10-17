import { expect, test } from "bun:test";
import { PERSONAL_ATTEMPTS } from "../security/personal-budget";
import { authorizationRefreshDelay, sameAuthorizations } from "./authorization-refresh";

test("ten setup or idle tabs leave room for page loads in the account polling budget", () => {
  const limits = PERSONAL_ATTEMPTS["oauth-authorizations"];
  for (const settingUp of [true, false]) {
    const requests: number[] = [];
    for (let tab = 0; tab < 10; tab++) {
      requests.push(0); // The initial authorized-agent load uses the same budget.
      let delay = authorizationRefreshDelay(0, { settingUp, changed: true });
      for (let time = delay; time < 3_600_000; time += delay) {
        requests.push(time);
        delay = authorizationRefreshDelay(delay, { settingUp, changed: false });
      }
      // Conservatively include a separate wake-event read per tab every minute.
      for (let time = 60_000; time < 3_600_000; time += 60_000) requests.push(time);
    }
    requests.sort((a, b) => a - b);
    expect(requests.length).toBeLessThan(limits.hour);
    let windowStart = 0;
    for (let index = 0; index < requests.length; index++) {
      while (requests[index]! - requests[windowStart]! >= 60_000) windowStart++;
      expect(index - windowStart + 1).toBeLessThan(limits.minute);
    }
  }
});

test("unchanged results and failures back off, while a changed grant restores prompt refresh", () => {
  let delay = authorizationRefreshDelay(0, { settingUp: true, changed: true });
  const waits = [delay];
  for (let attempt = 0; attempt < 5; attempt++) {
    delay = authorizationRefreshDelay(delay, { settingUp: true, changed: false });
    waits.push(delay);
  }
  expect(waits).toEqual([5000, 10000, 20000, 40000, 60000, 60000]);
  expect(authorizationRefreshDelay(delay, { settingUp: true, changed: true })).toBe(5000);
  expect(authorizationRefreshDelay(delay, { settingUp: false, changed: true })).toBe(15000);
});

test("authorization changes use grant identity and name, independent of row order", () => {
  const clients = [
    { clientId: "a", name: "Codex" },
    { clientId: "b", name: "Codex" },
  ];
  expect(sameAuthorizations(clients, [...clients].reverse())).toBe(true);
  expect(sameAuthorizations(clients, [clients[0]!])).toBe(false);
  expect(
    sameAuthorizations(clients, [
      { clientId: "a", name: "Codex" },
      { clientId: "c", name: "Codex" },
    ]),
  ).toBe(false);
  expect(sameAuthorizations(clients, [{ clientId: "a", name: "Claude Code" }, clients[1]!])).toBe(
    false,
  );
});
