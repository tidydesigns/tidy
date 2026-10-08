import { z } from "zod";
import { agentFailure, agentJson, agentSession } from "@/lib/agents/http";
import { getThreadEvents } from "@/lib/agents/store";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await agentSession(request);
    const id = z.uuid().parse((await context.params).id);
    const after = z.coerce
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .parse(new URL(request.url).searchParams.get("after") ?? "0");
    return agentJson({ events: await getThreadEvents(session.user.id, id, after) });
  } catch (error) {
    return agentFailure(error);
  }
}
