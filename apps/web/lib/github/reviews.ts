import { GitHubRequestError } from "./request-error";
import { mapConcurrent } from "@/lib/map-concurrent";
import { storeDesignObject, designObjectKey } from "@/lib/storage/design-objects";
import { assertGitHubHistoryUsage, assertGitHubSnapshotSize } from "./history-limits";
import { requireFilePermission } from "@/lib/organizations/authorization";
import { VIEW_ROLES_SQL } from "@/lib/organizations/roles";
import { reserveImageOperation } from "@/lib/design/image-budget";
import { inDatabaseScope } from "@/lib/database-scope";
import {
  checkReviewProviderAuthority,
  withFileProviderAuthority,
  withReviewProviderAuthority,
} from "./review-authority";
import { documentAssetIds } from "@/lib/design/document";
import { createHash, randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import type { DesignDocument } from "@/lib/design/document";
import { boundedGitHubOperation, githubRequest, paginated } from "./client";
import { githubSchemaReady, repositoryAccess, requireSchema } from "./connections";
import {
  captureBytes,
  captureSchema,
  feedbackSchema,
  linkSchema,
  parsePullUrl,
  responseSchema,
  safePreviewUrl,
  snapshotFrames,
  checkedPull,
} from "./validation";

export type Review = {
  id: string;
  fileId: string;
  organizationId: string;
  installationId: string;
  repositoryId: string;
  repository: string;
  number: number;
  title: string;
  url: string;
  state: string;
  branch: string;
  baseSha: string;
  headSha: string;
  linkedSha: string;
  revision: number;
  frameIds: string[];
  content: DesignDocument;
  createdAt: Date;
};
export type Capture = {
  id: string;
  frameId: string;
  sha: string;
  route: string;
  width: number;
  height: number;
  createdAt: Date;
};
export type Feedback = {
  id: string;
  captureId: string | null;
  nodeId: string | null;
  point: { x: number; y: number } | null;
  sha: string;
  body: string;
  authorId: string;
  authorName: string;
  status: "open" | "proposed" | "verified";
  response: string | null;
  fixSha: string | null;
  githubCommentId: string | null;
  createdAt: Date;
};
export type Pull = {
  number: number;
  title: string;
  html_url: string;
  state: string;
  merged: boolean;
  updated_at: string;
  base: { sha: string; repo: { id: number; full_name: string } };
  head: { sha: string; ref: string };
};
export async function fileOrganization(userId: string, fileId: string) {
  const result = await db.query<{ organizationId: string }>(
    `select f."organizationId" from "designFile" f join "member" m on m."organizationId" = f."organizationId"
    join "user" u on u."id"=m."userId" and u."emailVerified"=true
    where f."id" = $1 and m."userId" = $2 and m."role" in ${VIEW_ROLES_SQL} and f."archivedAt" is null`,
    [fileId, userId],
  );
  if (!result.rows[0]) throw new GitHubRequestError("Design file not found or access denied.", 403);
  return result.rows[0].organizationId;
}
export const linkPullRequest = boundedGitHubOperation(async function linkPullRequest(
  userId: string,
  fileId: string,
  input: unknown,
) {
  await requireFilePermission(userId, fileId, "edit");
  const value = linkSchema.parse(input);
  const parsed = parsePullUrl(value.url);
  await requireSchema();
  const organizationId = await fileOrganization(userId, fileId);
  // Resolve the repository with the user's credentials, then verify installation access.
  const { userToken } = await import("./client");
  const repository = await githubRequest<{ id: number }>(
    await userToken(userId),
    `/repos/${parsed.repository}`,
  );
  const access = await repositoryAccess(userId, organizationId, repository.id);
  const pull = checkedPull(
    await githubRequest<Pull>(
      access.token,
      `/repos/${access.repository.full_name}/pulls/${parsed.number}`,
    ),
  );
  if (pull.base.repo.id !== repository.id)
    throw new GitHubRequestError("Pull request repository mismatch.");
  return withFileProviderAuthority(
    userId,
    { fileId, organizationId },
    access,
    "edit",
    async (client) => {
      const document = await client.query<{ revision: number; content: DesignDocument }>(
        `select d."revision", d."content" from "designDocument" d join "designFile" f on f."id" = d."fileId" join "member" m on m."organizationId" = f."organizationId" and m."userId" = $2 where d."fileId" = $1 and f."archivedAt" is null for update of d`,
        [fileId, userId],
      );
      const current = document.rows[0];
      if (!current || current.revision !== value.expectedRevision)
        throw new GitHubRequestError(
          "The design changed. Read the current revision before linking the PR.",
        );
      const frameIds = [...new Set(value.frameIds)].sort();
      const frameKey = createHash("sha256").update(JSON.stringify(frameIds)).digest("hex");
      const existing = await client.query<{ id: string }>(
        `select "id" from "githubReview" where "fileId"=$1 and "organizationId"=$2
        and "repositoryId"=$3 and "number"=$4 and "revision"=$5 and "frameKey"=$6`,
        [fileId, organizationId, repository.id, pull.number, current.revision, frameKey],
      );
      if (existing.rowCount) return { reviewId: existing.rows[0].id };
      const content = snapshotFrames(current.content, frameIds);
      const serialized = JSON.stringify(content);
      await assertGitHubSnapshotSize(client, serialized);
      const id = randomUUID();
      const inserted = await client.query<{ id: string }>(
        `insert into "githubReview" ("id","fileId","organizationId","installationId","repositoryId","repository","number","title","url","state","branch","baseSha","headSha","linkedSha","revision","frameIds","content","createdBy","frameKey")
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,$15,$16,$17,$18)
      on conflict ("fileId","repositoryId","number","revision","frameKey") do nothing returning "id"`,
        [
          id,
          fileId,
          organizationId,
          access.installationId,
          repository.id,
          access.repository.full_name,
          pull.number,
          pull.title,
          pull.html_url,
          pull.merged ? "merged" : pull.state,
          pull.head.ref,
          pull.base.sha,
          pull.head.sha,
          current.revision,
          JSON.stringify(frameIds),
          serialized,
          userId,
          frameKey,
        ],
      );
      let reviewId = inserted.rows[0]?.id;
      if (reviewId) {
        const assetIds = documentAssetIds(content);
        const copied = await client.query(
          `insert into "githubReviewAsset" ("reviewId","assetId","mimeType","body","objectKey","byteSize","sha256") select $1,"id","mimeType","body","objectKey","byteSize","sha256" from "designAsset" where "organizationId" = $2 and "id" = any($3::text[])`,
          [id, organizationId, assetIds],
        );
        if (copied.rowCount !== assetIds.length)
          throw new GitHubRequestError("A design asset is missing. The snapshot was not created.");
        await assertGitHubHistoryUsage(client, organizationId, fileId, id, "review");
      } else {
        reviewId = (
          await client.query<{ id: string }>(
            `select "id" from "githubReview" where "fileId"=$1 and "repositoryId"=$2 and "number"=$3 and "revision"=$4 and "frameKey"=$5 and "organizationId"=$6`,
            [fileId, repository.id, pull.number, current.revision, frameKey, organizationId],
          )
        ).rows[0]?.id;
      }
      if (!reviewId) throw new GitHubRequestError("Review identity changed. Try again.");
      return { reviewId };
    },
    { historyAdmission: true },
  );
});
export const authorizedReview = boundedGitHubOperation(async function authorizedReview(
  userId: string,
  id: string,
) {
  await requireSchema();
  const result = await db.query<Review>(
    `select r."id",r."fileId",r."organizationId",r."installationId",r."repositoryId",r."repository",
    r."number",r."title",r."url",r."state",r."branch",r."baseSha",r."headSha",r."linkedSha",
    r."revision",r."frameIds",r."content",r."createdAt"
    from "githubReview" r join "designFile" f on f."id" = r."fileId" and f."organizationId"=r."organizationId"
    join "member" m on m."organizationId" = f."organizationId" and m."userId" = $2 and m."role" in ${VIEW_ROLES_SQL}
    join "user" u on u."id"=m."userId" and u."emailVerified"=true where r."id" = $1 and f."archivedAt" is null`,
    [id, userId],
  );
  const review = result.rows[0];
  if (!review) throw new GitHubRequestError("Review not found or access denied.", 403);
  const access = await repositoryAccess(userId, review.organizationId, review.repositoryId);
  const resultAccess = { review, ...access };
  await checkReviewProviderAuthority(userId, resultAccess);
  return resultAccess;
});
export const authorizedReviewImageAccess = boundedGitHubOperation(
  async function authorizedReviewImageAccess(userId: string, id: string) {
    await requireSchema();
    const result = await db.query<
      Pick<Review, "id" | "fileId" | "organizationId" | "repositoryId" | "number">
    >(
      `select r."id",r."fileId",r."organizationId",r."repositoryId",r."number" from "githubReview" r
    join "designFile" f on f."id"=r."fileId" and f."organizationId"=r."organizationId"
    join "member" m on m."organizationId"=f."organizationId" and m."userId"=$2 and m."role" in ${VIEW_ROLES_SQL}
    join "user" u on u."id"=m."userId" and u."emailVerified"=true
    where r."id"=$1 and f."archivedAt" is null`,
      [id, userId],
    );
    const review = result.rows[0];
    if (!review) throw new GitHubRequestError("Review not found or access denied.", 403);
    await reserveImageOperation("read", userId, review.organizationId);
    const access = {
      review,
      ...(await repositoryAccess(userId, review.organizationId, review.repositoryId)),
    };
    await checkReviewProviderAuthority(userId, access);
    return access;
  },
);
export const listReviews = boundedGitHubOperation(async function listReviews(
  userId: string,
  fileId: string,
) {
  const organizationId = await fileOrganization(userId, fileId);
  if (!(await githubSchemaReady())) return { ready: false, reviews: [] };
  const rows = await db.query<Omit<Review, "content">>(
    `select "id","fileId","organizationId","installationId","repositoryId","repository","number","title","url","state","branch","baseSha","headSha","linkedSha","revision","frameIds","createdAt" from "githubReview" where "fileId"=$1 and "organizationId"=$2 order by "createdAt" desc`,
    [fileId, organizationId],
  );
  const repositories = [...new Map(rows.rows.map((row) => [row.repositoryId, row])).values()];
  const permissions = await mapConcurrent(repositories, 4, async (row) => {
    try {
      const access = await repositoryAccess(userId, row.organizationId, row.repositoryId);
      return [row.repositoryId, access] as const;
    } catch {
      return [row.repositoryId, null] as const;
    }
  });
  const allowed = new Map(permissions);
  const authorities = [...allowed.values()].filter((access) => access !== null);
  if (!authorities.length) {
    if ((await fileOrganization(userId, fileId)) !== organizationId)
      throw new GitHubRequestError("Review access denied or changed. Try again.", 403);
    return { ready: true, reviews: [] };
  }
  const authority = authorities[0];
  if (
    authorities.some(
      (access) =>
        access.githubId !== authority.githubId ||
        access.credentialVersion !== authority.credentialVersion,
    )
  )
    throw new GitHubRequestError("Review access denied or changed. Try again.", 403);
  return withFileProviderAuthority(
    userId,
    { fileId, organizationId },
    authority,
    "view",
    async (client) => {
      const installations = await client.query<{ installationId: string }>(
        `select "installationId" from "githubConnection"
      where "organizationId"=$1 and "installationId"=any($2::bigint[]) and "active"=true for share`,
        [organizationId, authorities.map((access) => access.installationId)],
      );
      const live = new Set(installations.rows.map((row) => row.installationId));
      const reviews = rows.rows.filter((row) => {
        const access = allowed.get(row.repositoryId);
        return access && live.has(access.installationId);
      });
      return { ready: true, reviews };
    },
  );
});
export const getReviewContext = boundedGitHubOperation(async function getReviewContext(
  userId: string,
  id: string,
) {
  const access = await authorizedReview(userId, id);
  // Serialize reconciliation with webhook/other readers. Fetch current state rather than replaying payload state.
  const lock = await db.connect();
  let pull: Pull;
  try {
    await lock.query("begin");
    await lock.query(`select pg_advisory_xact_lock(hashtext($1))`, [id]);
    pull = checkedPull(
      await githubRequest<Pull>(
        access.token,
        `/repos/${access.repository.full_name}/pulls/${access.review.number}`,
      ),
    );
    if (String(pull.base.repo.id) !== access.review.repositoryId)
      throw new GitHubRequestError("Repository mismatch.");
    await inDatabaseScope(lock, () =>
      withFileProviderAuthority(userId, access.review, access, "view", async (lock) => {
        const saved = await lock.query(
          `update "githubReview" set "repository"=$2,"title"=$3,"url"=$4,"state"=$5,"branch"=$6,"baseSha"=$7,"headSha"=$8 where "id"=$1 and "fileId"=$9 and "organizationId"=$10 and "repositoryId"=$11 and "number"=$12`,
          [
            id,
            pull.base.repo.full_name,
            pull.title,
            pull.html_url,
            pull.merged ? "merged" : pull.state,
            pull.head.ref,
            pull.base.sha,
            pull.head.sha,
            access.review.fileId,
            access.review.organizationId,
            access.review.repositoryId,
            access.review.number,
          ],
        );
        if (!saved.rowCount)
          throw new GitHubRequestError("Review access denied or changed. Try again.", 403);
      }),
    );
    await lock.query("commit");
  } catch (error) {
    await lock.query("rollback");
    throw error;
  } finally {
    lock.release();
  }
  const path = `/repos/${access.repository.full_name}`;
  const [captures, feedback, checks, status, deployments, comments] = await Promise.all([
    db.query<Capture>(
      `select "id","frameId","sha","route","width","height","createdAt" from "githubCapture" where "reviewId"=$1 order by "createdAt" desc`,
      [id],
    ),
    db.query<Feedback>(
      `select f."id",f."captureId",f."nodeId",f."point",f."sha",f."body",f."authorId",f."status",f."response",
      f."fixSha",f."githubCommentId",f."createdAt",u."name" as "authorName"
      from "githubFeedback" f join "user" u on u."id"=f."authorId" where f."reviewId"=$1 order by f."createdAt"`,
      [id],
    ),
    githubRequest<{
      check_runs: {
        name: string;
        status: string;
        conclusion: string | null;
        html_url: string | null;
      }[];
    }>(access.token, `${path}/commits/${pull.head.sha}/check-runs?per_page=100`).catch(() => null),
    githubRequest<{ state: string }>(access.token, `${path}/commits/${pull.head.sha}/status`).catch(
      () => null,
    ),
    githubRequest<{ id: number; sha: string; environment: string }[]>(
      access.token,
      `${path}/deployments?sha=${pull.head.sha}&per_page=10`,
    ).catch(() => []),
    githubRequest<{ id: number; body: string; html_url: string; user: { login: string } }[]>(
      access.token,
      `${path}/issues/${pull.number}/comments?per_page=100`,
    ).catch(() => null),
  ]);
  let previewUrl: string | null = null;
  for (const deployment of deployments) {
    if (deployment.sha !== pull.head.sha || /production/i.test(deployment.environment)) continue;
    const statuses = await githubRequest<{ state: string; environment_url: string }[]>(
      access.token,
      `${path}/deployments/${deployment.id}/statuses?per_page=1`,
    ).catch(() => []);
    if (statuses[0]?.state === "success") previewUrl = safePreviewUrl(statuses[0].environment_url);
    if (previewUrl) break;
  }
  return withReviewProviderAuthority(userId, access, "view", async (client) => {
    const assets = await client.query<{ assetId: string; mimeType: string }>(
      `select "assetId", "mimeType" from "githubReviewAsset" where "reviewId"=$1`,
      [id],
    );
    return {
      review: {
        ...access.review,
        content: {
          ...access.review.content,
          assetMimeTypes: Object.fromEntries(
            assets.rows.map((asset) => [asset.assetId, asset.mimeType]),
          ),
        },
        repository: pull.base.repo.full_name,
        title: pull.title,
        url: pull.html_url,
        branch: pull.head.ref,
        state: pull.merged ? "merged" : pull.state,
        headSha: pull.head.sha,
        baseSha: pull.base.sha,
      },
      captures: captures.rows,
      feedback: feedback.rows,
      checks: checks?.check_runs ?? null,
      commitStatus: status?.state ?? null,
      comments,
      previewUrl,
    };
  });
});
export type ReviewContext = Awaited<ReturnType<typeof getReviewContext>>;
export const uploadCapture = boundedGitHubOperation(async function uploadCapture(
  userId: string,
  id: string,
  input: unknown,
) {
  const value = captureSchema.parse(input);
  const access = await authorizedReview(userId, id);
  await requireFilePermission(userId, access.review.fileId, "edit");
  if (!access.review.frameIds.includes(value.frameId))
    throw new GitHubRequestError("Capture must target a frame in this design snapshot.");
  const pull = checkedPull(
    await githubRequest<Pull>(
      access.token,
      `/repos/${access.repository.full_name}/pulls/${access.review.number}`,
    ),
  );
  if (pull.head.sha !== value.sha)
    throw new GitHubRequestError(
      "PR head changed. Capture the current head commit before uploading.",
    );
  const body = captureBytes(value.base64, value.mimeType);
  const digest = createHash("sha256").update(body).digest("hex");
  return withReviewProviderAuthority(
    userId,
    access,
    "edit",
    async (client) => {
      const existing = await client.query<{ id: string }>(
        `select "id" from "githubCapture" where "reviewId"=$1 and "frameId"=$2 and "sha"=$3
      and "route"=$4 and "width"=$5 and "height"=$6 and "sha256"=$7`,
        [id, value.frameId, value.sha, value.route, value.width, value.height, digest],
      );
      if (existing.rowCount) return { captureId: existing.rows[0].id };
      // Reserve the local history row before touching R2. The uncommitted body
      // provides accurate accounting even when the final image lives in R2.
      const result = await client.query<{ id: string }>(
        `insert into "githubCapture" ("id","reviewId","frameId","sha","route","width","height","mimeType","body","sha256","objectKey","byteSize") values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    on conflict ("reviewId","frameId","sha","route","width","height","sha256") do update set "sha256"=excluded."sha256" returning "id"`,
        [
          randomUUID(),
          id,
          value.frameId,
          value.sha,
          value.route,
          value.width,
          value.height,
          value.mimeType,
          body,
          digest,
          designObjectKey(access.review.organizationId, digest, value.mimeType),
          body.byteLength,
        ],
      );
      await assertGitHubHistoryUsage(
        client,
        access.review.organizationId,
        access.review.fileId,
        id,
        "capture",
      );
      const stored = (
        await inDatabaseScope(client, () =>
          storeDesignObject(access.review.organizationId, value.mimeType, body),
        )
      ).value;
      await client.query(
        'update "githubCapture" set "body"=$2,"objectKey"=$3,"byteSize"=$4 where "id"=$1 and "reviewId"=$5',
        [result.rows[0].id, stored.objectKey ? null : body, stored.objectKey, stored.byteSize, id],
      );
      return { captureId: result.rows[0].id };
    },
    { historyAdmission: true },
  );
});
export const createFeedback = boundedGitHubOperation(async function createFeedback(
  userId: string,
  id: string,
  input: unknown,
) {
  const value = feedbackSchema.parse(input);
  const access = await authorizedReview(userId, id);
  const { review } = access;
  if (value.nodeId && !review.content.nodes.some((node) => node.id === value.nodeId))
    throw new GitHubRequestError("Layer is not in this design snapshot.");
  if (value.point && !value.captureId)
    throw new GitHubRequestError("A screenshot point requires a capture.");
  if (!value.captureId && value.sha !== review.linkedSha) {
    const pull = checkedPull(
      await githubRequest<Pull>(
        access.token,
        `/repos/${access.repository.full_name}/pulls/${review.number}`,
      ),
    );
    if (value.sha !== pull.head.sha)
      throw new GitHubRequestError("Choose the current commit or an existing capture.");
  }
  return withReviewProviderAuthority(
    userId,
    access,
    "comment",
    async (client) => {
      // Recheck the child in the same publication transaction.
      if (value.captureId) {
        const capture = await client.query(
          'select 1 from "githubCapture" where "id"=$1 and "reviewId"=$2 and "sha"=$3 for share',
          [value.captureId, id, value.sha],
        );
        if (!capture.rowCount)
          throw new GitHubRequestError("Capture does not match this review and commit.");
      }
      const feedbackId = randomUUID();
      await client.query(
        `insert into "githubFeedback" ("id","reviewId","captureId","nodeId","point","sha","body","authorId") values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          feedbackId,
          id,
          value.captureId ?? null,
          value.nodeId ?? null,
          value.point ? JSON.stringify(value.point) : null,
          value.sha,
          value.body,
          userId,
        ],
      );
      await assertGitHubHistoryUsage(client, review.organizationId, review.fileId, id, "feedback");
      return { feedbackId };
    },
    { historyAdmission: true },
  );
});
export const recordFeedbackResponse = boundedGitHubOperation(async function recordFeedbackResponse(
  userId: string,
  id: string,
  input: unknown,
) {
  const value = responseSchema.parse(input);
  const access = await authorizedReview(userId, id);
  await requireFilePermission(userId, access.review.fileId, "edit");
  const commits = await paginated<{ sha: string }>(
    access.token,
    `/repos/${access.repository.full_name}/pulls/${access.review.number}/commits`,
  );
  if (!commits.some((commit) => commit.sha === value.sha))
    throw new GitHubRequestError("Fix commit is not part of this pull request.");
  return withReviewProviderAuthority(
    userId,
    access,
    "edit",
    async (client) => {
      const previous = await client.query<{ retainedBytes: string }>(
        `select "retainedBytes" from "githubFeedback" where "id"=$1 and "reviewId"=$2 and "status"<>'verified' for update`,
        [value.feedbackId, id],
      );
      if (!previous.rowCount)
        throw new GitHubRequestError("Feedback not found or already verified.");
      const updated = await client.query<{ retainedBytes: string }>(
        `update "githubFeedback" set "status"='proposed',"response"=$3,"fixSha"=$4 where "id"=$1 and "reviewId"=$2 and "status" <> 'verified' returning "retainedBytes"`,
        [value.feedbackId, id, value.body, value.sha],
      );
      if (!updated.rowCount)
        throw new GitHubRequestError("Feedback not found or already verified.");
      if (Number(updated.rows[0].retainedBytes) > Number(previous.rows[0].retainedBytes))
        await assertGitHubHistoryUsage(
          client,
          access.review.organizationId,
          access.review.fileId,
          id,
        );
      return { feedbackId: value.feedbackId, status: "proposed" };
    },
    { historyAdmission: true },
  );
});
export const verifyFeedback = boundedGitHubOperation(async function verifyFeedback(
  userId: string,
  id: string,
  feedbackId: string,
  captureId: string,
) {
  const access = await authorizedReview(userId, id);
  await requireFilePermission(userId, access.review.fileId, "edit");
  return withReviewProviderAuthority(userId, access, "edit", async (client) => {
    const updated = await client.query(
      `update "githubFeedback" f set "status"='verified' from "githubCapture" c where f."id"=$1 and f."reviewId"=$2 and f."authorId"=$3 and f."status"='proposed' and c."id"=$4 and c."reviewId"=f."reviewId" and c."sha"=f."fixSha"
    and (f."captureId" is null or exists (select 1 from "githubCapture" original where original."id"=f."captureId" and original."frameId"=c."frameId" and original."route"=c."route" and original."width"=c."width" and original."height"=c."height"))`,
      [feedbackId, id, userId, captureId],
    );
    if (!updated.rowCount)
      throw new GitHubRequestError(
        "Only the feedback author can verify it against a capture of the proposed fix commit.",
      );
  });
});
export const sendFeedback = boundedGitHubOperation(async function sendFeedback(
  userId: string,
  id: string,
  feedbackId: string,
) {
  const access = await authorizedReview(userId, id);
  await requireFilePermission(userId, access.review.fileId, "edit");
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await client.query<Feedback>(
      `select * from "githubFeedback" where "id"=$1 and "reviewId"=$2 and "authorId"=$3 for update`,
      [feedbackId, id, userId],
    );
    const feedback = result.rows[0];
    if (!feedback) throw new GitHubRequestError("Only the feedback author can send it to GitHub.");
    if (feedback.githubCommentId) {
      await inDatabaseScope(client, () =>
        withReviewProviderAuthority(userId, access, "edit", async () => {}),
      );
      await client.query("commit");
      return { commentId: feedback.githubCommentId };
    }
    const marker = `<!-- tidy-feedback:${feedbackId} -->`;
    const path = `/repos/${access.repository.full_name}/issues/${access.review.number}/comments`;
    // Recover a successful remote POST if a previous local transaction failed.
    const previous = (
      await paginated<{ id: number; body: string; user: { id: number } }>(access.token, path)
    ).find(
      (comment) => comment.body.includes(marker) && String(comment.user.id) === access.githubId,
    );
    const publication = await inDatabaseScope(client, () =>
      withReviewProviderAuthority(userId, access, "edit", async (authorized) => {
        const node = access.review.content.nodes.find((item) => item.id === feedback.nodeId);
        const { githubConfig } = await import("./config");
        const link = `${githubConfig().origin}/files/${encodeURIComponent(access.review.fileId)}?review=${encodeURIComponent(id)}`;
        const body = `${feedback.body}\n\nDesign review: ${link}\nDesign revision: ${access.review.revision}\nReviewed commit: ${feedback.sha}${node ? `\nLayer: ${node.name}${node.sourcePath ? ` (${node.sourcePath})` : ""}` : ""}${feedback.captureId ? `\nCapture: ${feedback.captureId}` : ""}${feedback.point ? `\nScreenshot point: ${Math.round(feedback.point.x * 100)}%, ${Math.round(feedback.point.y * 100)}%` : ""}\n\n${marker}`;
        const comment =
          previous ??
          (await githubRequest<{ id: number }>(access.token, path, {
            method: "POST",
            body: JSON.stringify({ body }),
          }));
        await authorized.query(
          `update "githubFeedback" set "githubCommentId"=$2 where "id"=$1 and "reviewId"=$3 and "authorId"=$4`,
          [feedbackId, comment.id, id, userId],
        );
        return { commentId: String(comment.id) };
      }),
    );
    await client.query("commit");
    return publication.value;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
});
