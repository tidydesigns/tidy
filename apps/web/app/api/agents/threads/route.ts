import { z } from "zod";
import { agentBody, agentFailure, agentJson, agentSession } from "@/lib/agents/http";
import { agentModel } from "@/lib/agents/config";
import { listAgentThreads, startAgentRun } from "@/lib/agents/store";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const session = await agentSession(request),
      params = new URL(request.url).searchParams;
    const query = z
      .object({
        organizationId: z.string().min(1).max(120),
        fileId: z.string().min(1).max(120).optional(),
        before: z
          .string()
          .min(1)
          .max(200)
          .regex(/^[A-Za-z0-9_-]+$/)
          .optional(),
      })
      .parse(Object.fromEntries(params));
    return agentJson({
      threads: await listAgentThreads(
        session.user.id,
        query.organizationId,
        query.fileId,
        query.before,
      ),
    });
  } catch (error) {
    return agentFailure(error);
  }
}
export async function POST(request: Request) {
  try {
    const session = await agentSession(request);
    return agentJson(
      await startAgentRun(session.user.id, await agentBody(request), agentModel()),
      201,
    );
  } catch (error) {
    return agentFailure(error);
  }
}
