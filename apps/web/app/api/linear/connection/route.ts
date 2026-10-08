import { z } from "zod";
import { connectorError, connectorJson, connectorUser, json } from "@/lib/connectors/http";
import { disconnectLinear, linearStatus } from "@/lib/linear/connections";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const userId = await connectorUser(request);
    const organizationId = z
      .string()
      .min(1)
      .max(200)
      .parse(new URL(request.url).searchParams.get("organizationId"));
    return json(await linearStatus(userId, organizationId));
  } catch (error) {
    return connectorError(error);
  }
}
export async function DELETE(request: Request) {
  try {
    const userId = await connectorUser(request, true);
    const { organizationId, connectionId } = z
      .object({ organizationId: z.string().min(1).max(200), connectionId: z.string().uuid() })
      .parse(await connectorJson(request));
    await disconnectLinear(userId, organizationId, connectionId);
    return json({ disconnected: true });
  } catch (error) {
    return connectorError(error);
  }
}
