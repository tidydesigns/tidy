import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("GitHub validates response fields while preserving extras, pagination bounds and empty responses", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--eval",
      `
    import { mock, expect } from "bun:test";
    import { z } from "zod";
    mock.module("server-only", () => ({}));
    const { githubRequest, checkedGitHub, paginated } = await import("./lib/github/client.ts");
    let data = null, calls = 0;
    globalThis.fetch = async () => { calls++; return data === undefined ? new Response(null, { status: 204 }) : Response.json(data); };
    const schema = z.object({ id: z.number().int().positive() });
    for (const value of [null, {}, { id: "1" }]) {
      data = value;
      await expect(checkedGitHub(schema, githubRequest("fixture", "/fixture"))).rejects.toMatchObject({ status: 502 });
    }
    expect(calls).toBe(3);
    data = { id: 1, added: true };
    expect(await checkedGitHub(schema, githubRequest("fixture", "/fixture"))).toEqual({ id: 1 });
    data = [{ id: "invalid" }];
    await expect(checkedGitHub(z.array(schema), paginated("fixture", "/fixture"))).rejects.toMatchObject({ status: 502 });
    data = undefined;
    expect(await githubRequest("fixture", "/fixture")).toBeNull();
  `,
    ],
    { cwd: resolve(import.meta.dir, "../.."), env: process.env },
  );
  expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
});
