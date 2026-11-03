import { expect, test } from "bun:test";
import { CommunityRepository } from "./community-repository";

test("reads the star status for the fixed community repository", async () => {
  const calls: string[][] = [];
  let starred = false;
  const repository = new CommunityRepository(async (args) => {
    calls.push(args);
    return JSON.stringify({ data: { repository: { viewerHasStarred: starred } } });
  });
  expect(await repository.status()).toBe("unstarred");
  starred = true;
  expect(await repository.status()).toBe("starred");
  expect(calls[0]).toEqual([
    "graphql",
    "-f",
    'query={repository(owner:"tidydesigns",name:"tidy"){viewerHasStarred}}',
  ]);
});

test("unavailable authentication and malformed responses never invite the user", async () => {
  for (const response of ["not json", "{}", '{"data":{"repository":null}}']) {
    expect(await new CommunityRepository(async () => response).status()).toBe("unavailable");
  }
  const repository = new CommunityRepository(async () => {
    throw new Error("private authentication details");
  });
  expect(await repository.status()).toBe("unavailable");
  expect(await repository.star()).toBe(false);
});

test("stars only the fixed repository and reports success after the command finishes", async () => {
  const calls: string[][] = [];
  let finish: (value: string) => void = () => {};
  const repository = new CommunityRepository((args) => {
    calls.push(args);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  let complete = false;
  const operation = repository.star().then((value) => {
    complete = value;
  });
  expect(complete).toBe(false);
  expect(calls).toEqual([["--method", "PUT", "/user/starred/tidydesigns/tidy"]]);
  finish("");
  await operation;
  expect(complete).toBe(true);
});
