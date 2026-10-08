import { linkPullRequest, listReviews } from "@/lib/github/reviews";
import { apiError, json, requestJson, requestUser } from "@/lib/github/http";

export const runtime = "nodejs";
export async function GET(request: Request, { params }: { params: Promise<{ uid: string }> }) {
  try {
    return json(await listReviews(await requestUser(request), (await params).uid));
  } catch (error) {
    return apiError(error);
  }
}
export async function POST(request: Request, { params }: { params: Promise<{ uid: string }> }) {
  try {
    return json(
      await linkPullRequest(
        await requestUser(request, true),
        (await params).uid,
        await requestJson(request),
      ),
    );
  } catch (error) {
    return apiError(error);
  }
}
