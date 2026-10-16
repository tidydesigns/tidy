import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

test("Postgres SQL files live in migrations/", async () => {
  const files = await readdir(new URL("../../../", import.meta.url));
  expect(files.filter((file) => file.endsWith(".sql"))).toEqual([]);
});
