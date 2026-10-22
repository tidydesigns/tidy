import { requireMcpAuth } from "@better-auth/mcp";
import { z } from "zod";
import { DESKTOP_SYNC_SCOPE, desktopSyncResource } from "@tidy/design/cloud-sync";
import { auth } from "@/lib/auth";
import { hasMcpAuthorization, McpGrantError } from "@/lib/mcp/authorizations";
import { withDesktopAuthority } from "@/lib/desktop/authority";
import {
  createDesktopFile,
  renameDesktopFile,
  desktopManifest,
  DesktopNameConflict,
} from "@/lib/desktop/files";
import { listDesignFolders } from "@/lib/design/folder-service";
import { thumbnailResponseForUser } from "@/lib/design/thumbnail-service";
import { listDesignOrganizations, listDesignFiles, getDesignFile } from "@/lib/design/service";
import {
  getDocument,
  ensureEditorDocument,
  getExportAssets,
  putAsset,
} from "@/lib/design/document-service";
import { readFileChanges } from "@/lib/design/changes";
import { commitDocumentPatch, DocumentRevisionConflict } from "@/lib/design/commands";
import { documentPatchSchema } from "@/lib/design/document-patch";
import { DOCUMENT_HISTORY_LIMITS, ExpiredDocumentEdit } from "@/lib/design/history-retention";
import { documentAssetIds } from "@/lib/design/document";
import { can } from "@/lib/organizations/roles";
import { operationBudgetResponse, operationFailure } from "@/lib/security/operation-budget";
import { boundedRequest, RequestBodyError, requestBodyError } from "@/lib/http/request-body";
import { runWithRequestSignal } from "@/lib/request-lifecycle";

export const runtime = "nodejs";
const resource = desktopSyncResource(process.env.BETTER_AUTH_URL ?? "http://localhost:3000");
const scope = [DESKTOP_SYNC_SCOPE];
const revision = z.coerce.number().int().min(0).max(2147483647);
const commitSchema = z
  .object({ operationId: z.uuid(), baseRevision: revision, patch: documentPatchSchema })
  .strict();
const imageSchema = z
  .object({ mimeType: z.string().max(100), base64: z.string().max(2_800_000) })
  .strict();
const json = (body: unknown) =>
  Response.json(body, { headers: { "Cache-Control": "private, no-store" } });

/** Cookie sessions and MCP audiences cannot authorize this native-app boundary. */
const handle = requireMcpAuth(
  auth,
  async (request, claims) => {
    if (!(await hasMcpAuthorization(claims, resource, scope)))
      return new Response(null, { status: 401 });
    const userId = claims.sub as string;
    const url = new URL(request.url);
    const denied = await operationBudgetResponse(
      request.method === "GET" || url.pathname === "/api/desktop/manifest"
        ? "document-read"
        : "document-request",
      userId,
    );
    if (denied) return denied;
    const grant = { claims, resource, scopes: scope };
    const path = url.pathname.slice("/api/desktop/".length).split("/").map(decodeURIComponent);
    try {
      if (request.method === "POST" && path.join("/") === "manifest") {
        const body = z
          .object({ fileIds: z.array(z.uuid()).min(1).max(1000) })
          .strict()
          .parse(await (await boundedRequest(request, 64_000)).json());
        // Unlike asset reads this does no external I/O: retain authority through publication.
        return json(
          await withDesktopAuthority(
            grant,
            undefined,
            false,
            () => desktopManifest(userId, [...new Set(body.fileIds)]),
            undefined,
            true,
          ),
        );
      }
      if (request.method === "GET" && path.join("/") === "account")
        return json(
          await withDesktopAuthority(grant, undefined, false, async () => ({
            id: userId,
            organizations: await listDesignOrganizations(userId),
          })),
        );
      if (
        request.method === "GET" &&
        path.length === 3 &&
        path[0] === "organizations" &&
        path[2] === "catalog"
      )
        return json(
          await withDesktopAuthority(grant, path[1], false, async () => {
            const [files, folders] = await Promise.all([
              listDesignFiles(userId, path[1]),
              listDesignFolders(userId, path[1]),
            ]);
            return { files, folders };
          }),
        );
      if (
        request.method === "GET" &&
        path.length === 3 &&
        path[0] === "organizations" &&
        path[2] === "files"
      )
        return json(
          await withDesktopAuthority(grant, path[1], false, () => listDesignFiles(userId, path[1])),
        );
      if (
        request.method === "POST" &&
        path.length === 3 &&
        path[0] === "organizations" &&
        path[2] === "files"
      ) {
        const body = z
          .object({
            id: z.uuid(),
            name: z
              .string()
              .trim()
              .min(1)
              .max(120)
              .refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
          })
          .strict()
          .parse(await (await boundedRequest(request, 4096)).json());
        return json(
          await withDesktopAuthority(grant, path[1], true, () =>
            createDesktopFile(userId, path[1], body.id, body.name),
          ),
        );
      }
      if (
        path[0] !== "files" ||
        path.length < 2 ||
        path.length > 3 ||
        !z.uuid().safeParse(path[1]).success
      )
        return new Response(null, { status: 404 });
      const fileId = path[1];
      const file = await getDesignFile(userId, fileId, false);
      if (!file) return new Response(null, { status: 404 });
      const write = request.method === "POST";
      if (write && !can(file.role, "edit")) return new Response(null, { status: 403 });
      // Read the bounded body before holding authority locks.
      const input = write
        ? await (
            await boundedRequest(
              request,
              path[2] === "assets" ? 2_900_000 : DOCUMENT_HISTORY_LIMITS.operationBytes,
            )
          ).json()
        : undefined;
      return await withDesktopAuthority(
        grant,
        file.organizationId,
        write,
        async () => {
          if (request.method === "POST" && path[2] === "name") {
            const name = z
              .string()
              .trim()
              .min(1)
              .max(120)
              .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
            const body = z.object({ before: name, name }).strict().parse(input);
            return json(await renameDesktopFile(userId, fileId, body.before, body.name));
          }
          if (request.method === "GET" && path[2] === "thumbnail")
            return thumbnailResponseForUser(userId, fileId, request);
          if (request.method === "GET" && path.length === 2) {
            const since = url.searchParams.get("revision");
            const requestedRevision = since === null ? null : revision.parse(since);
            let row = await readFileChanges(userId, fileId, requestedRevision);
            // Native documents and empty deltas never fetch a second full snapshot.
            if (!row?.initialized) {
              await ensureEditorDocument(userId, fileId);
              row = await readFileChanges(userId, fileId, requestedRevision);
            }
            if (!row) return new Response(null, { status: 404 });
            return json({
              name: row.name,
              canEdit: can(row.role, "edit"),
              sequence: Number(row.sequence),
              ...(row.patches
                ? { baseRevision: Number(since), revision: row.revision, patches: row.patches }
                : { snapshot: { revision: row.revision, content: row.content } }),
            });
          }
          if (request.method === "POST" && path.length === 2) {
            const body = commitSchema.parse(input);
            const result = await commitDocumentPatch(
              userId,
              fileId,
              body.operationId,
              body.baseRevision,
              body.patch,
              false,
              undefined,
              undefined,
              undefined,
              undefined,
              true,
            );
            // A retry returns the original receipt, never a newer snapshot that could
            // falsely acknowledge another client's intervening changes.
            return json({
              baseRevision: result.baseRevision,
              revision: result.committedRevision,
              patch: result.patch,
            });
          }
          if (path[2] === "assets" && request.method === "GET") {
            const assetId = z.uuid().parse(url.searchParams.get("id"));
            const document = await getDocument(userId, fileId);
            if (!document || !documentAssetIds(document.content).includes(assetId))
              return new Response(null, { status: 404 });
            return json((await getExportAssets(userId, [assetId]))[0]);
          }
          if (path[2] === "assets" && request.method === "POST") {
            const body = imageSchema.parse(input);
            return json(
              await putAsset(
                userId,
                file.organizationId,
                body.mimeType,
                body.base64,
                request.signal,
              ),
            );
          }
          return new Response(null, { status: 404 });
        },
        fileId,
      );
    } catch (error) {
      const limited = operationFailure(error);
      if (limited) return limited;
      if (error instanceof RequestBodyError) return requestBodyError(error);
      if (error instanceof McpGrantError) return new Response(null, { status: 401 });
      if (
        error instanceof DocumentRevisionConflict ||
        error instanceof ExpiredDocumentEdit ||
        error instanceof DesktopNameConflict
      )
        return Response.json({ code: "REVISION_CONFLICT" }, { status: 409 });
      if (error instanceof z.ZodError) return new Response(null, { status: 400 });
      return Response.json({ error: "Cloud sync is temporarily unavailable." }, { status: 503 });
    }
  },
  { resource, requiredScopes: scope },
);

export function GET(request: Request) {
  return runWithRequestSignal(request.signal, () => handle(request));
}
export function POST(request: Request) {
  return runWithRequestSignal(request.signal, () => handle(request));
}
