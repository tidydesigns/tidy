import { withRequestBodyLimit } from "@/lib/http/request-body";
import { captureWebRequest } from "@/lib/analytics/web-ingestion";
export const POST = withRequestBodyLimit(captureWebRequest, 2048);
