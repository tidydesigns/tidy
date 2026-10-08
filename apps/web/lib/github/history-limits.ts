import { GitHubRequestError } from "./request-error";
import type { PoolClient } from "pg";
import { GITHUB_HISTORY_LIMITS as limits } from "@/lib/security/resource-limits";

export class GitHubHistoryLimitError extends Error {
  constructor() {
    super(
      "This workspace has reached its GitHub review history limit. Contact support for capacity.",
    );
  }
}

/** Same lock as original-storage plan admission; a second lock would reverse
 * acquisition order when composed with other scoped product tools. */
export async function lockGitHubHistory(client: PoolClient, organizationId: string) {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [organizationId]);
}

/** Caller holds the organization admission lock. Run after local writes, before
 * any object upload/commit: rejection rolls back the entire history publication. */
export async function assertGitHubHistoryUsage(
  client: PoolClient,
  organizationId: string,
  fileId: string,
  reviewId?: string,
  kind?: "review" | "capture" | "feedback",
) {
  const usage = (
    await client.query<{
      reviews: string;
      fileReviews: string;
      captures: string;
      reviewCaptures: string;
      feedback: string;
      reviewFeedback: string;
      bytes: string;
      unmetered: string;
    }>(
      `with reviews as materialized (
        select "id","fileId","retainedBytes" from "githubReview" where "organizationId"=$1
      ), captures as (
        select count(*) as count, count(*) filter (where c."reviewId"=$3) as selected,
          coalesce(sum(c."retainedBytes"),0) as bytes,
          count(*) filter (where c."body" is null and coalesce(c."byteSize",0)<=0) as unmetered
        from "githubCapture" c join reviews r on r."id"=c."reviewId"
      ), feedback as (
        select count(*) as count, count(*) filter (where f."reviewId"=$3) as selected,
          coalesce(sum(f."retainedBytes"),0) as bytes
        from "githubFeedback" f join reviews r on r."id"=f."reviewId"
      ), assets as (
        select coalesce(sum(a."retainedBytes"),0) as bytes,
          count(*) filter (where a."body" is null and coalesce(a."byteSize",0)<=0) as unmetered
        from "githubReviewAsset" a join reviews r on r."id"=a."reviewId"
      ) select
        (select count(*)::text from reviews) as reviews,
        (select count(*) filter (where "fileId"=$2)::text from reviews) as "fileReviews",
        c.count::text as captures,c.selected::text as "reviewCaptures",
        f.count::text as feedback,f.selected::text as "reviewFeedback",
        ((select coalesce(sum("retainedBytes"),0) from reviews)+c.bytes+f.bytes+a.bytes)::text as bytes,
        (c.unmetered+a.unmetered)::text as unmetered
      from captures c cross join feedback f cross join assets a`,
      [organizationId, fileId, reviewId ?? null],
    )
  ).rows[0];
  if (
    Number(usage.unmetered) > 0 ||
    Number(usage.bytes) > limits.bytesPerOrganization ||
    (kind === "review" &&
      (Number(usage.reviews) > limits.reviewsPerOrganization ||
        Number(usage.fileReviews) > limits.reviewsPerFile)) ||
    (kind === "capture" &&
      (Number(usage.captures) > limits.capturesPerOrganization ||
        Number(usage.reviewCaptures) > limits.capturesPerReview)) ||
    (kind === "feedback" &&
      (Number(usage.feedback) > limits.feedbackPerOrganization ||
        Number(usage.reviewFeedback) > limits.feedbackPerReview))
  )
    throw new GitHubHistoryLimitError();
}

export async function assertGitHubSnapshotSize(client: PoolClient, content: string) {
  const result = await client.query<{ bytes: number }>(
    "select octet_length($1::jsonb::text) as bytes",
    [content],
  );
  if (result.rows[0].bytes > limits.snapshotBytes)
    throw new GitHubRequestError(
      "This design snapshot is too large. Link fewer or smaller frames.",
      409,
    );
}
