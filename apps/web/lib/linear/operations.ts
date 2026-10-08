import "server-only";
import { z } from "zod";
import { ConnectorError } from "@/lib/connectors/http";
import { linearAccess } from "./connections";
import { linearRequest } from "./client";
import { withLinearAuthority, type LinearAuthority } from "./authority";
import { reserveLinearReceipt, finishLinearReceipt } from "./receipts";
import { boundedLinearOperation } from "./work-budget";

export const connectionInput = z.object({
  organizationId: z.string().min(1).max(200),
  connectionId: z.string().uuid(),
});
const issueId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^(?:[a-zA-Z][a-zA-Z0-9]*-\d+|[a-f0-9-]{36})$/, "Use a Linear issue identifier or UUID.");
export const linearInputs = {
  teams: connectionInput.extend({ after: z.string().max(500).optional() }),
  search: connectionInput.extend({
    query: z.string().trim().min(1).max(200),
    teamId: z.string().uuid().optional(),
    after: z.string().max(500).optional(),
  }),
  issue: connectionInput.extend({ issueId }),
  comments: connectionInput.extend({ issueId, after: z.string().max(500).optional() }),
  create: connectionInput.extend({
    operationId: z.string().uuid(),
    teamId: z.string().uuid(),
    title: z.string().trim().min(1).max(250),
    description: z.string().max(20000).optional(),
  }),
  comment: connectionInput.extend({
    operationId: z.string().uuid(),
    issueId,
    body: z.string().trim().min(1).max(10000),
  }),
  update: connectionInput
    .extend({
      operationId: z.string().uuid(),
      issueId,
      expectedUpdatedAt: z.string().datetime(),
      title: z.string().trim().min(1).max(250).optional(),
      description: z.string().max(20000).optional(),
      stateId: z.string().uuid().optional(),
    })
    .refine(
      (input) =>
        input.title !== undefined || input.description !== undefined || input.stateId !== undefined,
      "Choose fields to update.",
    ),
};
type Base = z.infer<typeof connectionInput>;
type Page<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  updatedAt: string;
  team: { id: string; name: string };
  state: { id: string; name: string; type: string };
  assignee: { id: string; name: string } | null;
};
const issueFields =
  "id identifier title description url updatedAt team { id name } state { id name type } assignee { id name }";

async function readIssue(token: string, id: string) {
  const data = await linearRequest<{ issue: LinearIssue | null }>(
    token,
    `query TidyIssue($id: String!) { issue(id: $id) { ${issueFields} } }`,
    { id },
  );
  if (!data.issue) throw new ConnectorError("Issue not found or access removed.", 404);
  return data.issue;
}
export const listLinearTeams = boundedLinearOperation(async function listLinearTeams(
  userId: string,
  raw: unknown,
) {
  const input = linearInputs.teams.parse(raw);
  const access = await linearAccess(userId, input.organizationId, input.connectionId);
  const { token } = access;
  const result = await linearRequest<{ teams: Page<{ id: string; name: string; key: string }> }>(
    token,
    "query TidyTeams($after: String) { teams(first: 50, after: $after) { nodes { id name key } pageInfo { hasNextPage endCursor } } }",
    { after: input.after },
  );
  return withLinearAuthority(userId, access, false, async () => result);
});
export const searchLinearIssues = boundedLinearOperation(async function searchLinearIssues(
  userId: string,
  raw: unknown,
) {
  const input = linearInputs.search.parse(raw);
  const access = await linearAccess(userId, input.organizationId, input.connectionId);
  const { token } = access;
  const result = await linearRequest<{
    issues: Page<Omit<LinearIssue, "description" | "assignee">>;
  }>(
    token,
    "query TidySearch($filter: IssueFilter!, $after: String) { issues(first: 25, after: $after, filter: $filter) { nodes { id identifier title url updatedAt team { id name } state { id name type } } pageInfo { hasNextPage endCursor } } }",
    {
      after: input.after,
      filter: {
        title: { containsIgnoreCase: input.query },
        ...(input.teamId ? { team: { id: { eq: input.teamId } } } : {}),
      },
    },
  );
  return withLinearAuthority(userId, access, false, async () => result);
});
export const getLinearIssue = boundedLinearOperation(async function getLinearIssue(
  userId: string,
  raw: unknown,
) {
  const input = linearInputs.issue.parse(raw);
  const access = await linearAccess(userId, input.organizationId, input.connectionId);
  const { token } = access;
  const issue = await readIssue(token, input.issueId);
  const states = await linearRequest<{
    workflowStates: Page<{ id: string; name: string; type: string }>;
  }>(
    token,
    "query TidyStates($teamId: ID!) { workflowStates(first: 100, filter: { team: { id: { eq: $teamId } } }) { nodes { id name type } pageInfo { hasNextPage endCursor } } }",
    { teamId: issue.team.id },
  );
  return withLinearAuthority(userId, access, false, async () => ({
    issue,
    states: states.workflowStates,
  }));
});
export const listLinearComments = boundedLinearOperation(async function listLinearComments(
  userId: string,
  raw: unknown,
) {
  const input = linearInputs.comments.parse(raw);
  const access = await linearAccess(userId, input.organizationId, input.connectionId);
  const { token } = access;
  const data = await linearRequest<{
    issue: {
      comments: Page<{
        id: string;
        body: string;
        updatedAt: string;
        user: { name: string } | null;
      }>;
    } | null;
  }>(
    token,
    "query TidyComments($id: String!, $after: String) { issue(id: $id) { comments(first: 50, after: $after) { nodes { id body updatedAt user { name } } pageInfo { hasNextPage endCursor } } } }",
    { id: input.issueId, after: input.after },
  );
  if (!data.issue) throw new ConnectorError("Issue not found or access removed.", 404);
  return withLinearAuthority(userId, access, false, async () => data.issue!);
});

/** Reserve first, then retain live authority for the external POST. Never retry
 * an ambiguous remote mutation; its receipt survives enclosing tool rollback. */
async function mutate(
  userId: string,
  access: LinearAuthority,
  input: Base & { operationId: string },
  kind: string,
  payload: unknown,
  run: () => Promise<{ id: string }>,
  prepare: () => Promise<void> = async () => {},
) {
  const reservation = await reserveLinearReceipt(userId, access, input.operationId, kind, payload);
  if (!reservation.fresh) return reservation.result;
  try {
    await prepare();
    return await withLinearAuthority(userId, access, true, async () => {
      const result = await run();
      await finishLinearReceipt(access.connectionId, input.operationId, result);
      return result;
    });
  } catch (error) {
    // A failed status write leaves 'pending', which also blocks another POST.
    await finishLinearReceipt(access.connectionId, input.operationId).catch(() => {});
    throw error;
  }
}
export const createLinearIssue = boundedLinearOperation(async function createLinearIssue(
  userId: string,
  raw: unknown,
) {
  const input = linearInputs.create.parse(raw);
  const access = await linearAccess(userId, input.organizationId, input.connectionId, true);
  const { token } = access;
  const team = await linearRequest<{ team: { id: string } | null }>(
    token,
    "query TidyTeam($id: String!) { team(id: $id) { id } }",
    { id: input.teamId },
  );
  if (!team.team) throw new ConnectorError("Team not found or access removed.", 404);
  const result = await mutate(userId, access, input, "issueCreate", input, async () => {
    const data = await linearRequest<{
      issueCreate: { success: boolean; issue: { id: string } | null };
    }>(
      token,
      "mutation TidyCreateIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id } } }",
      { input: { teamId: input.teamId, title: input.title, description: input.description } },
    );
    if (!data.issueCreate.success || !data.issueCreate.issue)
      throw new ConnectorError("Linear did not confirm issue creation.", 502);
    return { id: data.issueCreate.issue.id };
  });
  const updated = await readIssue(token, result.id);
  return withLinearAuthority(userId, access, true, async () => ({ issue: updated }));
});
export const addLinearComment = boundedLinearOperation(async function addLinearComment(
  userId: string,
  raw: unknown,
) {
  const input = linearInputs.comment.parse(raw);
  const access = await linearAccess(userId, input.organizationId, input.connectionId, true);
  const { token } = access;
  const issue = await readIssue(token, input.issueId);
  const result = await mutate(userId, access, input, "commentCreate", input, async () => {
    const data = await linearRequest<{
      commentCreate: { success: boolean; comment: { id: string } | null };
    }>(
      token,
      "mutation TidyComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }",
      { input: { issueId: issue.id, body: input.body } },
    );
    if (!data.commentCreate.success || !data.commentCreate.comment)
      throw new ConnectorError("Linear did not confirm the comment.", 502);
    return { id: data.commentCreate.comment.id };
  });
  return withLinearAuthority(userId, access, true, async () => ({
    commentId: result.id,
    issueId: issue.id,
  }));
});
export const updateLinearIssue = boundedLinearOperation(async function updateLinearIssue(
  userId: string,
  raw: unknown,
) {
  const input = linearInputs.update.parse(raw);
  const access = await linearAccess(userId, input.organizationId, input.connectionId, true);
  const { token } = access;
  const issue = await readIssue(token, input.issueId);
  const result = await mutate(
    userId,
    access,
    input,
    "issueUpdate",
    input,
    async () => {
      const data = await linearRequest<{
        issueUpdate: { success: boolean; issue: { id: string } | null };
      }>(
        token,
        "mutation TidyUpdateIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id } } }",
        {
          id: issue.id,
          input: { title: input.title, description: input.description, stateId: input.stateId },
        },
      );
      if (!data.issueUpdate.success || !data.issueUpdate.issue)
        throw new ConnectorError("Linear did not confirm the update.", 502);
      return { id: data.issueUpdate.issue.id };
    },
    async () => {
      if (issue.updatedAt !== input.expectedUpdatedAt)
        throw new ConnectorError("The issue changed. Read it again before updating.", 409);
      if (input.stateId) {
        const state = await linearRequest<{ workflowState: { team: { id: string } } | null }>(
          token,
          "query TidyState($id: String!) { workflowState(id: $id) { team { id } } }",
          { id: input.stateId },
        );
        if (state.workflowState?.team.id !== issue.team.id)
          throw new ConnectorError("Choose a status from this issue's team.");
      }
    },
  );
  const updated = await readIssue(token, result.id);
  return withLinearAuthority(userId, access, true, async () => ({ issue: updated }));
});
