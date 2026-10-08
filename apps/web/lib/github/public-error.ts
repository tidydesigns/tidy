import { ZodError } from "zod";
import { GitHubRequestError } from "./request-error";
import { GitHubError } from "./client";
import { GitHubHistoryLimitError } from "./history-limits";
import { GitHubWorkLimitError } from "./work-budget";
import { OrganizationAccessError } from "@/lib/organizations/access-error";
import { RequestBodyError } from "@/lib/http/request-body";
import { MutationBudgetError } from "@/lib/security/mutation-budget";
import { ImageBudgetUnavailableError } from "@/lib/design/image-budget";
import { OAuthSessionError } from "@/lib/connectors/oauth-session";

/** Shared by browser JSON, MCP errors and connector-status DTOs. Never infer
 * safety from the absence of an SQL code or from an arbitrary exception message. */
export function publicGitHubMessage(error: unknown) {
  if (error instanceof ZodError) return "Invalid request fields.";
  if (
    error instanceof GitHubRequestError ||
    error instanceof GitHubError ||
    error instanceof GitHubHistoryLimitError ||
    error instanceof GitHubWorkLimitError ||
    error instanceof OrganizationAccessError ||
    error instanceof OAuthSessionError ||
    error instanceof RequestBodyError ||
    error instanceof MutationBudgetError ||
    error instanceof ImageBudgetUnavailableError
  )
    return error.message;
  return "Could not complete the request.";
}
