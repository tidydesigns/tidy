import { reviewImage } from "@/lib/github/images";
import { apiError, requestUser } from "@/lib/github/http";

export const runtime = "nodejs";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; captureId: string }> },
) {
  try {
    const { id, captureId } = await params;
    return await reviewImage(await requestUser(request), id, captureId, true, request);
  } catch (error) {
    return apiError(error);
  }
}
