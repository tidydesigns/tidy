import { expect, test } from "bun:test";
import { CommunityRepository } from "./community-repository";

test("reads the star status for the fixed community repository", async () => {
  let starred = false;
  const repository = new CommunityRepository(async () => {
    return JSON.stringify({ data: { repository: { viewerHasStarred: starred } } });
  });
  expect(await repository.status()).toBe("unstarred");
  starred = true;
  expect(await repository.status()).toBe("starred");
});

test("unavailable authentication and malformed responses return unavailable status", async () => {
  for (const response of ["not json", '{"data":{"repository":null}}']) {
    expect(await new CommunityRepository(async () => response).status()).toBe("unavailable");
  }
  const repository = new CommunityRepository(async () => {
    throw new Error("private authentication details");
  });
  expect(await repository.status()).toBe("unavailable");
  expect(await repository.star()).toBe(false);
});

test("stars only the fixed repository", async () => {
  const calls: string[][] = [];
  const repository = new CommunityRepository(async (args) => {
    calls.push(args);
    return "";
  });
  expect(await repository.star()).toBe(true);
  expect(calls).toEqual([["--method", "PUT", "/user/starred/tidydesigns/tidy"]]);
});
