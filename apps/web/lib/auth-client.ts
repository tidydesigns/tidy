import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import posthog from "posthog-js";
import { clearThumbnailCache } from "@/app/files/thumbnail-cache";

import { organizationRoles } from "@/lib/organizations/access-control";

export const authClient = createAuthClient({
  plugins: [organizationClient({ roles: organizationRoles }), oauthProviderClient()],
  fetchOptions: { timeout: 25_000 },
});

// Email verification needs a callback URL even on password sign-in. The default
// redirect plugin would reload the document on success, so this client lets Next
// perform the internal transition. Social/OAuth flows keep their native redirects.
export const passwordAuthClient = createAuthClient({
  disableDefaultFetchPlugins: true,
  fetchOptions: { timeout: 25_000 },
});

export function identifyPostHogUser(user: { id: string; email: string; name: string }) {
  posthog.identify(user.id, {
    email: user.email,
    name: user.name,
  });
}

export function resetPostHogUser() {
  clearThumbnailCache();
  posthog.reset();
}
