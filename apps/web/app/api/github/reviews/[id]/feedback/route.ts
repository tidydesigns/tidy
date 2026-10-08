import * as z from "zod";
import {
  createFeedback,
  recordFeedbackResponse,
  sendFeedback,
  verifyFeedback,
} from "@/lib/github/reviews";
import { apiError, json, requestJson, requestUser } from "@/lib/github/http";

export const runtime = "nodejs";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return json(
      await createFeedback(
        await requestUser(request, true),
        (await params).id,
        await requestJson(request),
      ),
    );
  } catch (error) {
    return apiError(error);
  }
}
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userId = await requestUser(request, true);
    const { id } = await params;
    const value = z
      .discriminatedUnion("action", [
        z.object({ action: z.literal("send"), feedbackId: z.string().uuid() }).strict(),
        z
          .object({
            action: z.literal("verify"),
            feedbackId: z.string().uuid(),
            captureId: z.string().uuid(),
          })
          .strict(),
        z
          .object({
            action: z.literal("respond"),
            feedbackId: z.string().uuid(),
            sha: z.string(),
            body: z.string(),
          })
          .strict(),
      ])
      .parse(await requestJson(request));
    if (value.action === "send") return json(await sendFeedback(userId, id, value.feedbackId));
    if (value.action === "respond")
      return json(
        await recordFeedbackResponse(userId, id, {
          feedbackId: value.feedbackId,
          sha: value.sha,
          body: value.body,
        }),
      );
    await verifyFeedback(userId, id, value.feedbackId, value.captureId);
    return json({ verified: true });
  } catch (error) {
    return apiError(error);
  }
}
