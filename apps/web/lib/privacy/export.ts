import "server-only";
import { db } from "@/lib/db";
import { ACCOUNT_EXPORT_LIMITS as limits } from "@/lib/security/resource-limits";
import { lockPrivacyAccount, PrivacyError } from "./access";
import { analyticsStorageEnabled } from "@/lib/analytics/store";

// Explicit projections ensure future credential columns cannot leak into exports.
// Shared content is included only while the requester remains a member.
const memberFile = `select f.id from "designFile" f join "member" m on m."organizationId"=f."organizationId" where m."userId"=$1`;
export const exportQueries: Record<string, string> = {
  profile:
    'select id,name,email,"emailVerified",image,"createdAt","updatedAt" from "user" where id=$1',
  accounts:
    'select "providerId","accountId",scope,"createdAt","updatedAt" from account where "userId"=$1',
  sessions:
    'select "createdAt","updatedAt","expiresAt","ipAddress","userAgent" from session where "userId"=$1',
  memberships:
    'select m."organizationId",o.name,m.role,m."createdAt" from member m join organization o on o.id=m."organizationId" where m."userId"=$1',
  invitations:
    'select "organizationId",role,status,"createdAt","expiresAt" from invitation where lower(email)=(select lower(email) from "user" where id=$1)',
  sentInvitations:
    'select "organizationId",role,status,"createdAt","expiresAt" from invitation where "inviterId"=$1',
  files: `select id,"organizationId",name,"createdAt","updatedAt" from "designFile" where "createdBy"=$1 and id in (${memberFile})`,
  documents: `select d."fileId",d.revision,d.content,d."updatedAt" from "designDocument" d join "designFile" f on f.id=d."fileId" where f."createdBy"=$1 and f.id in (${memberFile})`,
  folders:
    'select f.id,f."organizationId",f.name,f."createdAt" from "designFolder" f join member m on m."organizationId"=f."organizationId" where f."createdBy"=$1 and m."userId"=$1',
  comments: 'select id,"threadId",body,"createdAt" from "designCommentMessage" where "authorId"=$1',
  commentThreads:
    'select id,"fileId",x,y,"createdAt" from "designCommentThread" where "createdBy"=$1',
  reactions: 'select "messageId",emoji,"createdAt" from "designCommentReaction" where "userId"=$1',
  imports:
    'select id,"organizationId","fileId",name,status,"createdAt" from "designImport" where "userId"=$1',
  versions: `select id,"fileId",revision,name,"createdAt" from "designFileVersion" where "createdBy"=$1`,
  restores:
    'select "fileId","operationId","restoredVersionId","beforeVersionId","createdAt" from "designFileRestore" where "createdBy"=$1',
  github: 'select "githubId",login from "githubUser" where "userId"=$1',
  githubReviews:
    'select id,"fileId",repository,number,title,url,"createdAt" from "githubReview" where "createdBy"=$1',
  githubFeedback:
    'select id,"reviewId",body,status,response,"createdAt" from "githubFeedback" where "authorId"=$1',
  connectors:
    'select id,provider,"externalWorkspaceId","externalUserId","workspaceName","accountName",scopes,state,"updatedAt" from "connectorAccount" where "userId"=$1',
  connectorLinks:
    'select c."organizationId",c."accountId",c."createdAt" from "connectorConnection" c join "connectorAccount" a on a.id=c."accountId" where a."userId"=$1',
  agentConnection:
    'select provider,subject,"accountLabel",scopes,status,"updatedAt" from "agentConnection" where "userId"=$1',
  agentThreads:
    'select id,"organizationId",title,"createdAt","updatedAt" from "agentThread" where "createdBy"=$1',
  agentRuns:
    'select id,"threadId",model,status,reason,"createdAt","finishedAt" from "agentRun" where "ownerId"=$1',
  agentMessages:
    'select id,"threadId",kind,content,delivery,"createdAt" from "agentMessage" where "userId"=$1 or "runId" in (select id from "agentRun" where "ownerId"=$1)',
  oauthConsents:
    'select "clientId",scopes,resources,"createdAt","updatedAt" from "oauthConsent" where "userId"=$1',
  vault: 'select id,name,"createdAt" from "vaultLogin" where "userId"=$1',
  feedback: 'select id,category,message,"createdAt" from "feedbackSubmission" where "userId"=$1',
  feedbackUploads: 'select id,attachments,"createdAt" from "feedbackUpload" where "userId"=$1',
  mcpAnalyticsChoices:
    'select id,enabled,"noticeVersion","createdAt","lastChosenAt","expiresAt","retiredAt" from "mcpAnalyticsConsent" where "userId"=$1',
  privacyChoices:
    'select id,version,"noticeVersion",at,analytics,replay,diagnostics,"recordedAt","expiresAt" from "privacyConsent" where "userId"=$1',
  desktopAnalyticsChoices:
    'select d.id,d.usage,d.diagnostics,d.notice,d.revision,d."createdAt",d."linkedAt",d."lastExportAt",d."expiresAt" from "desktopAnalyticsConsent" d join "productAnalyticsAccount" a on a.id=d."accountId" where a."userId"=$1',
  productAnalytics:
    'select e.surface,e.purpose,e.name,e.at,e.properties from "productAnalyticsEvent" e join "productAnalyticsAccount" a on a.id=e."accountId" where a."userId"=$1 and e."expiresAt">clock_timestamp()',
};

let activeExports = 0;
const oversized = () =>
  new PrivacyError(
    "Your account is too large for an instant download. Contact the operator for a complete personal data export.",
    413,
  );

export async function exportAccount(userId: string, sessionId: string) {
  // No waiting queue that retains connections or account data. Shared attempt
  // limits still apply at the route; this bounds simultaneous isolate memory.
  if (activeExports >= limits.concurrent)
    throw new PrivacyError("Another data export is running. Try again shortly.", 503);
  activeExports++;
  try {
    return await readAccountExport(userId, sessionId);
  } finally {
    activeExports--;
  }
}

async function readAccountExport(userId: string, sessionId: string) {
  const client = await db.connect();
  try {
    await client.query("begin isolation level repeatable read");
    await lockPrivacyAccount(client, userId, sessionId);
    const data: Record<string, unknown> = {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      scope:
        "Personal account data, feedback stored in Tidy and currently accessible designs you created. Shared organization data belongs to the organization. Authentication secrets and vault credentials are excluded. Export complete design files from the editor, including assets. Contact the operator for historical analytics, legacy feedback held outside Tidy, or other processor records.",
    };
    const metadataBytes = Buffer.byteLength(JSON.stringify(data));
    const sections = Object.entries(exportQueries).filter(
      ([name]) =>
        analyticsStorageEnabled() ||
        !["desktopAnalyticsChoices", "productAnalytics"].includes(name),
    );
    let rows = 0,
      bytes = metadataBytes;
    // Measure every section inside the same snapshot before loading any private
    // records. Only scalar totals cross the database connection during admission.
    // LIMIT also bounds the work when an account has a huge number of small rows.
    for (const [section, query] of sections) {
      const size = (
        await client.query<{ count: number; bytes: string }>(
          `select count(*)::int as count,
           coalesce(sum(octet_length(row_to_json(export_row)::text)::bigint),0)::text as bytes
           from (${query} limit $2) export_row`,
          [userId, limits.rows - rows + 1],
        )
      ).rows[0];
      if (!size || !Number.isSafeInteger(size.count) || size.count < 0) throw oversized();
      const sectionBytes = Number(size.bytes);
      if (!Number.isSafeInteger(sectionBytes) || sectionBytes < 0) throw oversized();
      rows += size.count;
      // Include property names, array delimiters and commas in the output budget.
      bytes += sectionBytes + size.count + Buffer.byteLength(JSON.stringify(section)) + 4;
      if (rows > limits.rows || bytes > limits.bytes) throw oversized();
    }
    let serializedBytes = metadataBytes;
    for (const [section, query] of sections) {
      const records = (await client.query(`${query} limit $2`, [userId, limits.rows])).rows;
      // pg's JavaScript date/number serialization can differ from row_to_json.
      // Retain a final actual-byte check as well as the database-side preflight.
      serializedBytes +=
        Buffer.byteLength(JSON.stringify(records)) + Buffer.byteLength(JSON.stringify(section)) + 2;
      if (serializedBytes > limits.bytes) throw oversized();
      data[section] = records;
    }
    await client.query("commit");
    return data;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
