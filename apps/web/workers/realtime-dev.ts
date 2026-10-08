// Local companion for `next dev`. Production uses the custom OpenNext Worker.
import { upgradeFileRoom } from "../lib/realtime/upgrade";
import { verifyTicket } from "../lib/realtime/ticket";
import { agentActivitySchema } from "../lib/realtime/agent-activity";
export { FileRoom } from "../lib/realtime/file-room";
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (["/__relay", "/__activity"].includes(path) && request.method === "POST") {
      const ticket = await verifyTicket(
        request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "",
        env.BETTER_AUTH_SECRET,
      );
      if (!ticket || ticket.organizationId !== "internal" || ticket.userId !== "internal")
        return new Response(null, { status: 403 });
      if (path === "/__activity") {
        if (Number(request.headers.get("content-length")) > 2048)
          return new Response(null, { status: 413 });
        const input = agentActivitySchema.safeParse(await request.json());
        if (!input.success || input.data.fileId !== ticket.fileId)
          return new Response(null, { status: 400 });
        await env.FILE_ROOMS.getByName(ticket.fileId).activity(input.data);
      } else await env.FILE_ROOMS.getByName(ticket.fileId).sync(ticket.fileId);
      return new Response(null, { status: 204 });
    }
    return (await upgradeFileRoom(request, env)) ?? new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<CloudflareEnv>;
