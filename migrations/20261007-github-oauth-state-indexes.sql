-- Support bounded personal state admission and expiry cleanup. Local rollout only.
create index if not exists "githubOAuthState_user_expiry_idx"
  on "githubOAuthState" ("userId", "expiresAt") include ("organizationId");
create index if not exists "githubOAuthState_expiry_idx"
  on "githubOAuthState" ("expiresAt");
