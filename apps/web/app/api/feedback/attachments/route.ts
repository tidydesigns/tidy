import { auth } from "@/lib/auth";
import { storeAttachments } from "@/lib/feedback/storage";
import { FeedbackError, readUploadForm, UUID } from "@/lib/feedback/validation";
import { reserveFeedbackUpload } from "@/lib/feedback/upload-budget";
import { MutationBudgetError } from "@/lib/security/mutation-budget";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const origin = new URL(process.env.BETTER_AUTH_URL || request.url).origin;
  if (request.headers.get("origin") !== origin) return new Response(null, { status: 403 });
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user.emailVerified) return new Response(null, { status: 401 });
  try {
    await reserveFeedbackUpload(session.user.id);
    const form = await readUploadForm(request);
    const id = String(form.get("id") ?? "");
    if (!UUID.test(id)) throw new FeedbackError("Invalid upload ID.");
    const files = form.getAll("images");
    if (files.some((file) => !(file instanceof File)))
      throw new FeedbackError("Invalid image attachment.");
    const attachments = await storeAttachments(session.user.id, id, files as File[]);
    return Response.json(
      { urls: attachments.map((_, index) => `${origin}/api/feedback/attachments/${id}/${index}`) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof MutationBudgetError)
      return Response.json(
        { error: "Too many image uploads. Wait before trying again." },
        {
          status: 429,
          headers: { "Retry-After": String(error.retryAfter), "Cache-Control": "no-store" },
        },
      );
    if (error instanceof FeedbackError)
      return Response.json({ error: error.message }, { status: error.status });
    console.error("Feedback attachment upload failed", error);
    return Response.json({ error: "Could not upload images. Please try again." }, { status: 503 });
  }
}
