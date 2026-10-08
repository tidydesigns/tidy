import * as z from "zod";
import {
  attachInstallation,
  connectionStatus,
  disconnectGithubUser,
} from "@/lib/github/connections";
import { apiError, json, requestJson, requestUser } from "@/lib/github/http";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    return json(
      await connectionStatus(
        await requestUser(request),
        new URL(request.url).searchParams.get("organizationId") ?? "",
      ),
    );
  } catch (error) {
    return apiError(error);
  }
}
export async function POST(request: Request) {
  try {
    const userId = await requestUser(request, true);
    const value = z
      .object({
        organizationId: z.string().min(1),
        installationId: z.number().int().positive().safe(),
      })
      .strict()
      .parse(await requestJson(request));
    await attachInstallation(userId, value.organizationId, value.installationId);
    return json(await connectionStatus(userId, value.organizationId));
  } catch (error) {
    return apiError(error);
  }
}
export async function DELETE(request: Request) {
  try {
    const userId = await requestUser(request, true);
    await disconnectGithubUser(userId);
    return json({ disconnected: true });
  } catch (error) {
    return apiError(error);
  }
}
