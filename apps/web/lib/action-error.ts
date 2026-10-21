import "server-only";
import { reportHandledError } from "./handled-error";
import { planLimitMessage } from "@/lib/billing/plans";
import { PublicActionError } from "@/lib/security/public-error";
import { OrganizationAccessError } from "@/lib/organizations/access-error";

export function actionError(error: unknown, fallback: string) {
  const limit = planLimitMessage(error);
  if (limit) return limit;
  if (error instanceof PublicActionError || error instanceof OrganizationAccessError) {
    if (Object.hasOwn(error, "cause")) reportHandledError(error);
    return error.message;
  }
  reportHandledError(error);
  return fallback;
}
