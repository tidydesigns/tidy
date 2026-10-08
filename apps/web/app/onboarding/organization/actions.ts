"use server";

import { headers } from "next/headers";
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
