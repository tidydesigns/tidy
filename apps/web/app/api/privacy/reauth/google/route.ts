import { privacyReauthCallback } from "@/lib/privacy/reauth-callback";

export const GET = (request: Request) => privacyReauthCallback(request, "google");
