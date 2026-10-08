import { getReviewContext } from "@/lib/github/reviews";
import { apiError, json, requestUser } from "@/lib/github/http";

export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return json(await getReviewContext(await requestUser(request), (await params).id));
  } catch (error) {
    return apiError(error);
  }
}
