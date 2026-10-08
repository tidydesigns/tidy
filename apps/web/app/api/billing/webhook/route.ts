import Stripe from "stripe";
import { boundedRequest, RequestBodyError, requestBodyError } from "@/lib/http/request-body";
import { processBillingEvent } from "@/lib/billing/webhooks";
import { stripe } from "@/lib/billing/server";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return new Response("Stripe webhook is not configured.", { status: 503 });
  let body: string;
  try {
    body = await (await boundedRequest(request, 1024 * 1024)).text();
  } catch (error) {
    return error instanceof RequestBodyError
      ? requestBodyError(error)
      : new Response("Could not read webhook payload.", { status: 400 });
  }
  const signature = request.headers.get("stripe-signature");
  if (!signature) return new Response(null, { status: 401 });
  let event: Stripe.Event;
  try {
    event = await stripe().webhooks.constructEventAsync(
      body,
      signature,
      secret,
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch {
    return new Response(null, { status: 401 });
  }
  try {
    await processBillingEvent(event);
    return Response.json({ received: true });
  } catch (error) {
    console.error("Stripe webhook processing failed", error);
    return new Response("Could not process Stripe event.", { status: 503 });
  }
}
