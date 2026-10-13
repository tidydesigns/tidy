import { after } from "next/server";
import { processPrivacyCleanup } from "@/lib/privacy/cleanup";
import { deleteAccount } from "@/lib/privacy/delete";
import { privacyAccount, privacyFailure, privateHeaders, PrivacyError } from "@/lib/privacy/access";
import { boundedRequest } from "@/lib/http/request-body";
export async function POST(request: Request) {
  try {
    const { user, session } = await privacyAccount(request, "privacy-delete");
    const body = (await (await boundedRequest(request, 1024)).json()) as { confirmation?: unknown };
    if (typeof body?.confirmation !== "string")
      throw new PrivacyError("Enter your email address to confirm deletion.");
    await deleteAccount(user.id, session.id, body.confirmation);
    after(async () => {
      await processPrivacyCleanup().catch(() => console.error("privacy_cleanup_unavailable"));
    });
    return Response.json({ deleted: true }, { headers: privateHeaders });
  } catch (error) {
    return privacyFailure(error);
  }
}
