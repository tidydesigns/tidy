import { NextResponse } from "next/server";
import { privacyPolicyUrl } from "@/lib/privacy-notice";

export function GET() {
  return NextResponse.redirect(privacyPolicyUrl, 308);
}
