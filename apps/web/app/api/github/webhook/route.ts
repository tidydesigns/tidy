import { boundedRequest, RequestBodyError, requestBodyError } from "@/lib/http/request-body";
import { validWebhook } from "@/lib/github/crypto";
import { processWebhook } from "@/lib/github/webhooks";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return new Response("Webhook is not configured.", { status: 503 });
  let body: string;
  try {
    body = await (await boundedRequest(request, 1024 * 1024)).text();
  } catch (error) {
    return error instanceof RequestBodyError
      ? requestBodyError(error)
      : new Response("Could not read webhook payload.", { status: 400 });
  }
  if (!validWebhook(body, request.headers.get("x-hub-signature-256"), secret))
    return new Response(null, { status: 401 });
  const deliveryId = request.headers.get("x-github-delivery");
  const event = request.headers.get("x-github-event");
  if (!deliveryId || !/^[A-Za-z0-9-]{1,100}$/.test(deliveryId) || !event)
    return new Response(null, { status: 400 });
  try {
    await processWebhook(deliveryId, event, JSON.parse(body));
    return Response.json({ received: true });
  } catch {
    // Non-2xx leaves this delivery retryable; never persist a partially handled event.
    return new Response(
      "Could not process delivery. Redeliver after resolving the configuration or upstream error.",
      { status: 503 },
    );
  }
}
