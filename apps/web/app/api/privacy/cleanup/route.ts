import { timingSafeEqual } from "node:crypto";
import { processPrivacyCleanup } from "@/lib/privacy/cleanup";
import { privateHeaders } from "@/lib/privacy/access";
export async function POST(request: Request) {
  const secret = process.env.PRIVACY_CLEANUP_SECRET;
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  if (
    !secret ||
    secret.length < 32 ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  )
    return new Response(null, { status: 401, headers: privateHeaders });
  return Response.json(await processPrivacyCleanup(), { headers: privateHeaders });
}
