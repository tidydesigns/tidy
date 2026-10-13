import { exportAccount } from "@/lib/privacy/export";
import { privacyAccount, privacyFailure, privateHeaders } from "@/lib/privacy/access";
export async function POST(request: Request) {
  try {
    const { user, session } = await privacyAccount(request, "privacy-export");
    return Response.json(await exportAccount(user.id, session.id), {
      headers: {
        ...privateHeaders,
        "Content-Disposition": 'attachment; filename="tidy-personal-data.json"',
      },
    });
  } catch (error) {
    return privacyFailure(error);
  }
}
