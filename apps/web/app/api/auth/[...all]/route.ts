import { withRequestBodyLimit } from "@/lib/http/request-body";
import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

const handlers = toNextJsHandler(auth);
export const GET = handlers.GET;
export const POST = withRequestBodyLimit(handlers.POST);
