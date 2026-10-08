export function githubConfig() {
  return {
    appId: process.env.GITHUB_APP_ID ?? "",
    clientId: process.env.GITHUB_CLIENT_ID ?? "",
    slug: process.env.GITHUB_APP_SLUG ?? "",
    origin: new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000").origin,
  };
}

export function githubConfigured() {
  return Boolean(
    process.env.GITHUB_APP_ID &&
    process.env.GITHUB_CLIENT_ID &&
    process.env.GITHUB_APP_SLUG &&
    process.env.GITHUB_CLIENT_SECRET &&
    process.env.GITHUB_PRIVATE_KEY &&
    process.env.VAULT_ENCRYPTION_KEY,
  );
}
