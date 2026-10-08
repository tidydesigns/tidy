import { uploadCapture } from "@/lib/github/reviews";
import { apiError, json, requestJson, requestUser } from "@/lib/github/http";

export const runtime = "nodejs";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return json(
      await uploadCapture(
        await requestUser(request, true),
        (await params).id,
        await requestJson(request),
      ),
    );
  } catch (error) {
    return apiError(error);
  }
}
