import { expect, test } from "bun:test";
test("dismissal is remembered without changing access, and remains dismissed when storage fails", async () => {
  const { accessDefaultOfferDismissed, dismissAccessDefaultOffer, subscribeDefaultAccess } =
    (await import(
      new URL("./access-preferences.ts?dismissal-test", import.meta.url).href
    )) as typeof import("./access-preferences");
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const values = new Map<string, string>([["tidy:default-access", '"default"']]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  let changes = 0;
  const off = subscribeDefaultAccess(() => changes++);
  try {
    expect(accessDefaultOfferDismissed()).toBe(false);
    expect(dismissAccessDefaultOffer()).toBe(true);
    expect(accessDefaultOfferDismissed()).toBe(true);
    expect(values.get("tidy:access-default-offer-dismissed")).toBe("true");
    expect(values.get("tidy:default-access")).toBe('"default"');
    expect(changes).toBe(1);
    storage.setItem = () => {
      throw new Error("Storage unavailable");
    };
    expect(dismissAccessDefaultOffer()).toBe(false);
    expect(accessDefaultOfferDismissed()).toBe(true);
  } finally {
    off();
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
