// Secrets are configured separately from Wrangler's public binding configuration.
interface CloudflareEnv {
  BETTER_AUTH_SECRET: string;
  DATABASE_URL?: string;
}
