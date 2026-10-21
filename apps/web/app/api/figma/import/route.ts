import { actionError } from "@/lib/action-error";
import { operationBudgetResponse, operationFailure } from "@/lib/security/operation-budget";
import { revalidatePath } from "next/cache";
import { listDesignFolders } from "@/lib/design/folder-service";
import { auth } from "@/lib/auth";
import { boundedRequest, requestBodyError, RequestBodyError } from "@/lib/http/request-body";
import { documentAssetIds, parseDesignDocument } from "@tidy/design/document";
import { publishFigmaImport } from "@/lib/design/figma-import-service";
import { putAsset } from "@/lib/design/document-service";
import * as z from "zod";

const inputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    folderId: z.string().min(1).max(120).nullable().optional(),
    document: z.unknown(),
    assets: z
      .array(
        z
          .object({
            id: z.uuid(),
            mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
            base64: z.string().max(2_700_000),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export const runtime = "nodejs";
export async function POST(request: Request) {
  if (
    request.headers.get("origin") !==
    new URL(process.env.BETTER_AUTH_URL ?? "http://localhost:3000").origin
  )
    return new Response(null, { status: 403 });
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return Response.json({ error: "Sign in to import a Figma file." }, { status: 401 });
  const denied = await operationBudgetResponse("import-request", session.user.id);
  if (denied) {
    return denied;
  }
  try {
    const input = inputSchema.parse(await (await boundedRequest(request, 16_000_000)).json());
    const document = parseDesignDocument(input.document);
    if (!document.nodes.length) throw new Error("This Figma file contains no editable layers.");
    const organizations = await auth.api.listOrganizations({ headers: request.headers });
    const organization =
      organizations.find((o) => o.id === session.session.activeOrganizationId) ?? organizations[0];
    if (!organization) throw new Error("Choose a Tidy workspace first.");
    if (input.folderId) {
      const folders = await listDesignFolders(session.user.id, organization.id);
      if (!folders.some((folder) => folder.id === input.folderId && folder.canEdit))
        throw new Error("Folder not found or access denied.");
    }
    const supplied = new Set(input.assets.map((asset) => asset.id));
    if (supplied.size !== input.assets.length) throw new Error("Duplicate Figma asset identity.");
    if (documentAssetIds(document).some((id) => !supplied.has(id)))
      throw new Error("Figma image data is missing.");
    const ids = new Map<string, string>();
    for (const asset of input.assets) {
      if (ids.has(asset.id)) throw new Error("Duplicate Figma asset identity.");
      const uploaded = await putAsset(
        session.user.id,
        organization.id,
        asset.mimeType,
        asset.base64,
      );
      ids.set(asset.id, uploaded.assetId);
    }
    const remap = (id: string | undefined) => {
      if (!id) return;
      const target = ids.get(id);
      if (!target) throw new Error("Figma image data is missing.");
      return target;
    };
    document.nodes = document.nodes.map((node) => ({
      ...node,
      assetId: remap(node.assetId),
      style: {
        ...node.style,
        paints: node.style.paints?.map((p) =>
          p.type === "image" ? { ...p, assetId: remap(p.assetId) } : p,
        ),
      },
    }));
    const published = await publishFigmaImport(
      session.user.id,
      organization.id,
      input.name,
      document,
      input.folderId,
    );
    revalidatePath("/files");
    return Response.json(published, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    const denied = operationFailure(cause);
    if (denied) return denied;
    if (cause instanceof z.ZodError)
      return Response.json(
        { error: "This Figma import contains invalid layer or image data." },
        { status: 400 },
      );
    if (cause instanceof RequestBodyError) return requestBodyError(cause);
    return Response.json(
      { error: actionError(cause, "Could not import this Figma file. Please try again.") },
      { status: 400 },
    );
  }
}
