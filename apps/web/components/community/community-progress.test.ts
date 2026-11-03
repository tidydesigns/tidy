import { expect, test } from "bun:test";
import {
  communityEligible,
  communityKeys,
  dismissCommunity,
  recordCommunityDesign,
} from "./community-progress";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

test("qualifies after five distinct designs and bounds stored progress", () => {
  const saved = storage();
  for (let index = 0; index < 10; index++) recordCommunityDesign(saved, "user", "first");
  for (let index = 0; index < 3; index++) recordCommunityDesign(saved, "user", `design-${index}`);
  expect(communityEligible(saved, "user")).toBe(false);
  recordCommunityDesign(saved, "user", "fifth");
  expect(communityEligible(saved, "user")).toBe(true);
  for (let index = 0; index < 100; index++) recordCommunityDesign(saved, "user", `later-${index}`);
  expect(JSON.parse(saved.getItem(communityKeys("user").designs)!)).toHaveLength(5);
});

test("dismissal persists independently of stale progress writes", () => {
  const saved = storage();
  const keys = communityKeys("user");
  for (let index = 0; index < 5; index++) recordCommunityDesign(saved, "user", `${index}`);
  dismissCommunity(saved, "user");
  saved.setItem(keys.designs, JSON.stringify(["a", "b", "c", "d", "e"]));
  recordCommunityDesign(saved, "user", "another");
  expect(communityEligible(saved, "user")).toBe(false);
  expect(saved.getItem(keys.dismissed)).toBe("1");
});

test("progress and dismissal are scoped to the signed-in user", () => {
  const saved = storage();
  for (const user of ["first-user", "second-user"]) {
    for (let index = 0; index < 5; index++) recordCommunityDesign(saved, user, `${index}`);
  }
  dismissCommunity(saved, "first-user");
  expect(communityEligible(saved, "first-user")).toBe(false);
  expect(communityEligible(saved, "second-user")).toBe(true);
  expect(communityEligible(saved, "new-user")).toBe(false);
});

test("malformed and duplicate progress does not qualify or break future visits", () => {
  const saved = storage();
  const key = communityKeys("user").designs;
  for (const value of ["not json", "null", "{}", '["a","a","a","a","a"]', "[1,2,3,4,5]"]) {
    saved.setItem(key, value);
    expect(communityEligible(saved, "user")).toBe(false);
    recordCommunityDesign(saved, "user", "new");
    expect(JSON.parse(saved.getItem(key)!)).toContain("new");
  }
});

test("blocked browser storage never disrupts navigation or shows an invitation", () => {
  const blocked = {
    getItem(): never {
      throw new Error("Storage blocked");
    },
    setItem(): never {
      throw new Error("Storage blocked");
    },
  };
  expect(communityEligible(blocked, "user")).toBe(false);
  expect(() => recordCommunityDesign(blocked, "user", "design")).not.toThrow();
  expect(() => dismissCommunity(blocked, "user")).not.toThrow();
});
