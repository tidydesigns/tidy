import { timingSafeEqual } from "node:crypto";
import { analyticsStorageEnabled } from "@/lib/analytics/store";
import { runProductAnalyticsMaintenance } from "@/lib/analytics/maintenance";
export async function POST(request: Request) {
  const secret = process.env.PRIVACY_CLEANUP_SECRET;
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret ?? ""}`);
  if (
    !secret ||
    secret.length < 32 ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  )
    return new Response(null, { status: 401 });
  if (!analyticsStorageEnabled()) return new Response(null, { status: 204 });
  await runProductAnalyticsMaintenance();
  return new Response(null, { status: 204 });
}
