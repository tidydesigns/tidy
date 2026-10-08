import { boundedRequest, RequestBodyError, requestBodyError } from "@/lib/http/request-body";
import { connectorError } from "@/lib/connectors/http";
import { linearWebhook } from "@/lib/linear/webhooks";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    await linearWebhook(
      await (await boundedRequest(request, 1024 * 1024)).text(),
      request.headers.get("linear-signature"),
      request.headers.get("linear-delivery"),
    );
    return new Response(null, { status: 200 });
  } catch (error) {
    return error instanceof RequestBodyError ? requestBodyError(error) : connectorError(error);
  }
}
