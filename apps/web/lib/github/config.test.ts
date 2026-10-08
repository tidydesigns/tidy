import { expect, test } from "bun:test";
import { githubConfig, githubConfigured } from "./config";

test("GitHub has no hosted account fallback and requires an explicitly configured application", () => {
  const environment: Record<string, string | undefined> = process.env;
  const keys = [
    "GITHUB_APP_ID",
    "GITHUB_CLIENT_ID",
    "GITHUB_APP_SLUG",
    "GITHUB_CLIENT_SECRET",
    "GITHUB_PRIVATE_KEY",
    "VAULT_ENCRYPTION_KEY",
  ] as const;
  const saved = keys.map((key) => environment[key]);
  try {
    for (const key of keys) delete environment[key];
    expect(githubConfig()).toMatchObject({ appId: "", clientId: "", slug: "" });
    expect(githubConfigured()).toBe(false);
    for (const key of keys) environment[key] = "fixture";
    expect(githubConfigured()).toBe(true);
    delete environment.GITHUB_APP_ID;
    expect(githubConfigured()).toBe(false);
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete environment[key];
      else environment[key] = saved[index];
    });
  }
});
