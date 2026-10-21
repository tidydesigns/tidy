"use server";
import { reportHandledError } from "@/lib/handled-error";

import { headers } from "next/headers";
import { navigateWithFreshSession } from "@/lib/navigation/actions";
import {
  organizationCreationNavigationSchema,
  type OrganizationCreationNavigation,
} from "@/lib/organizations/name";
import { auth } from "@/lib/auth";
import { createOrganizationForUser, OrganizationCreationError } from "@/lib/organizations/creation";

export async function createOrganization(name: string) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return { data: null, error: { message: "Sign in to create an organization." } };
  try {
    return {
      data: await createOrganizationForUser(session.user.id, name, session.session.id),
      error: null,
    };
  } catch (error) {
    reportHandledError(error);
    return {
      data: null,
      error: {
        message:
          error instanceof OrganizationCreationError
            ? error.message
            : "Unable to create your organization. Please try again.",
      },
    };
  }
}

// Keep creation and the session-cache invalidation/redirect in one request.
// The destination is a closed set, never a caller-supplied redirect URL.
export async function createOrganizationAndContinue(
  input: OrganizationCreationNavigation,
): Promise<{ error: string }> {
  const parsed = organizationCreationNavigationSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const result = await createOrganization(parsed.data.name);
  if (!result.data) return { error: result.error.message };

  // Outside the mutation's catch: Next's redirect is successful control flow.
  return navigateWithFreshSession(
    parsed.data.destination === "team"
      ? `/onboarding/team?organizationId=${encodeURIComponent(result.data.id)}`
      : "/files",
    false,
  );
}
