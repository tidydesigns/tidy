import { auth } from "@/lib/auth";
import { githubConfig } from "./config";
import { GitHubError } from "./client";
import { boundedRequest, RequestBodyError } from "@/lib/http/request-body";
import { GitHubHistoryLimitError } from "./history-limits";
import { ZodError } from "zod";
import { GitHubRequestError } from "./request-error";
import { GitHubWorkLimitError } from "./work-budget";
import { OrganizationAccessError } from "@/lib/organizations/access-error";
import { MutationBudgetError } from "@/lib/security/mutation-budget";
import { ImageBudgetUnavailableError, imageFailureResponse } from "@/lib/design/image-budget";
import { ImageCapacityError } from "@/lib/design/image-capacity";
import { publicGitHubMessage } from "./public-error";
import { OAuthSessionError } from "@/lib/connectors/oauth-session";

export async function requestUser(request: Request, mutation = false) {
  return (await requestSession(request, mutation)).user.id;
}
export async function requestSession(request: Request, mutation = false) {
  if (mutation && request.headers.get("origin") !== githubConfig().origin)
    throw new GitHubRequestError("Request origin denied.", 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) throw new GitHubError(401);
  return session;
}
export async function requestJson(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new GitHubRequestError("Expected a JSON request.", 415);
  const limited = await boundedRequest(request, 3 * 1024 * 1024);
  try {
    return (await limited.json()) as unknown;
  } catch {
    throw new GitHubRequestError("Invalid JSON request.");
  }
}
export function json(value: unknown) {
  return Response.json(value, { headers: { "Cache-Control": "private, no-store" } });
}
export function apiError(error: unknown) {
  if (
    error instanceof MutationBudgetError ||
    error instanceof ImageBudgetUnavailableError ||
    error instanceof ImageCapacityError
  )
    return imageFailureResponse(error);
  const message = publicGitHubMessage(error);
  return Response.json(
    { error: message },
    {
      status:
        error instanceof ZodError
          ? 400
          : error instanceof GitHubRequestError
            ? error.status
            : error instanceof OrganizationAccessError || error instanceof OAuthSessionError
              ? 403
              : error instanceof GitHubWorkLimitError
                ? 422
                : error instanceof RequestBodyError
                  ? error.status
                  : error instanceof GitHubHistoryLimitError
                    ? 409
                    : error instanceof GitHubError
                      ? error.status === 401
                        ? 401
                        : error.status === 404
                          ? 404
                          : 502
                      : 503,
      headers: { "Cache-Control": "private, no-store" },
    },
  );
}
