import { reviewImage } from "@/lib/github/images";
import { apiError, requestUser } from "@/lib/github/http";

export const runtime = "nodejs";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; assetId: string }> },
) {
  try {
    const { id, assetId } = await params;
    return await reviewImage(await requestUser(request), id, assetId, false, request);
  } catch (error) {
    return apiError(error);
  }
}
