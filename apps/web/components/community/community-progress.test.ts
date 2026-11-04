import { expect, test } from "bun:test";
import {
  communityEligible,
  communityKeys,
  dismissCommunity,
  recordCommunityVisit,
} from "./community-progress";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

test("qualifies after three editor visits, including repeat visits to the same design", () => {
  const saved = storage();
  recordCommunityVisit(saved, "user", "same-design-first-visit");
  expect(communityEligible(saved, "user")).toBe(false);
  recordCommunityVisit(saved, "user", "same-design-second-visit");
  expect(communityEligible(saved, "user")).toBe(false);
  recordCommunityVisit(saved, "user", "same-design-third-visit");
  expect(communityEligible(saved, "user")).toBe(true);
  recordCommunityVisit(saved, "user", "fourth-visit");
  expect(JSON.parse(saved.getItem(communityKeys("user").visits)!)).toHaveLength(3);
});

test("rerenders and repeated effects count a mounted editor visit only once", () => {
  const saved = storage();
  recordCommunityVisit(saved, "user", "mounted-visit");
  recordCommunityVisit(saved, "user", "mounted-visit");
  expect(communityEligible(saved, "user")).toBe(false);
  expect(JSON.parse(saved.getItem(communityKeys("user").visits)!)).toEqual(["mounted-visit"]);
});

test("dismissal persists independently of stale progress writes", () => {
  const saved = storage();
  const keys = communityKeys("user");
  for (let index = 0; index < 3; index++) recordCommunityVisit(saved, "user", `${index}`);
  dismissCommunity(saved, "user");
  saved.setItem(keys.visits, JSON.stringify(["a", "b", "c"]));
  recordCommunityVisit(saved, "user", "another");
  expect(communityEligible(saved, "user")).toBe(false);
  expect(saved.getItem(keys.dismissed)).toBe("1");
});

test("progress and dismissal are scoped to the signed-in user", () => {
  const saved = storage();
  for (const user of ["first-user", "second-user"]) {
    for (let index = 0; index < 3; index++) recordCommunityVisit(saved, user, `${index}`);
  }
  dismissCommunity(saved, "first-user");
  expect(communityEligible(saved, "first-user")).toBe(false);
  expect(communityEligible(saved, "second-user")).toBe(true);
  expect(communityEligible(saved, "new-user")).toBe(false);
});

test("malformed and duplicate progress does not qualify or break future visits", () => {
  const saved = storage();
  const key = communityKeys("user").visits;
  for (const value of ["not json", "null", "{}", '["a","a","a"]', "[1,2,3]"]) {
    saved.setItem(key, value);
    expect(communityEligible(saved, "user")).toBe(false);
    recordCommunityVisit(saved, "user", "new");
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
  expect(() => recordCommunityVisit(blocked, "user", "visit")).not.toThrow();
  expect(() => dismissCommunity(blocked, "user")).not.toThrow();
});
