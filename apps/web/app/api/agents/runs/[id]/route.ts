import { z } from "zod";
import { agentBody, agentFailure, agentJson, agentSession } from "@/lib/agents/http";
import { steerAgentRun, stopAgentRun } from "@/lib/agents/store";

export const runtime = "nodejs";
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await agentSession(request);
    await stopAgentRun(session.user.id, z.uuid().parse((await context.params).id));
    return agentJson({ ok: true });
  } catch (error) {
    return agentFailure(error);
  }
}
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await agentSession(request);
    return agentJson({
      messageId: await steerAgentRun(
        session.user.id,
        z.uuid().parse((await context.params).id),
        await agentBody(request),
      ),
    });
  } catch (error) {
    return agentFailure(error);
  }
}
