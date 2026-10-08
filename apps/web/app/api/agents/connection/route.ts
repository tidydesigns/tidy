import { agentFailure, agentJson, agentSession } from "@/lib/agents/http";
import {
  connectionStatus,
  disconnectAgentConnection,
  refreshNativeConnection,
  startNativeLogin,
} from "@/lib/agents/connections";

export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const session = await agentSession(request);
    return agentJson(await connectionStatus(session.user.id));
  } catch (error) {
    return agentFailure(error);
  }
}
export async function POST(request: Request) {
  try {
    const session = await agentSession(request);
    return agentJson(await startNativeLogin(session.user.id));
  } catch (error) {
    return agentFailure(error);
  }
}
export async function PATCH(request: Request) {
  try {
    const session = await agentSession(request);
    return agentJson(await refreshNativeConnection(session.user.id));
  } catch (error) {
    return agentFailure(error);
  }
}
export async function DELETE(request: Request) {
  try {
    const session = await agentSession(request);
    await disconnectAgentConnection(session.user.id);
    return agentJson({ ok: true });
  } catch (error) {
    return agentFailure(error);
  }
}
