import { APIError } from "better-auth/api";

export function requireOrganizationName(name: string | undefined, confirmation: string | null) {
  let confirmedName: string | undefined;
  try {
    confirmedName = confirmation === null ? undefined : decodeURIComponent(confirmation);
  } catch {
    /* Invalid confirmation is rejected below. */
  }
  if (!name || confirmedName !== name) {
    throw new APIError("BAD_REQUEST", {
      code: "ORGANIZATION_NAME_MISMATCH",
      message: "Enter the organization name exactly to confirm deletion.",
    });
  }
}
