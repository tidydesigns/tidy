import { z } from "zod";
import { agentBody, agentFailure, agentJson, agentSession } from "@/lib/agents/http";
import { getAgentThread, renameAgentThread } from "@/lib/agents/store";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await agentSession(request),
      id = z.uuid().parse((await context.params).id);
    const value = new URL(request.url).searchParams.get("before");
    const before =
      value === null
        ? undefined
        : z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).parse(value);
    return agentJson(await getAgentThread(session.user.id, id, before));
  } catch (error) {
    return agentFailure(error);
  }
}
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await agentSession(request),
      id = z.uuid().parse((await context.params).id);
    const { title } = z
      .object({ title: z.string() })
      .strict()
      .parse(await agentBody(request));
    await renameAgentThread(session.user.id, id, title);
    return agentJson({ ok: true });
  } catch (error) {
    return agentFailure(error);
  }
}
