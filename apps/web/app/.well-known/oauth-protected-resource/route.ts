import { auth } from "@/lib/auth";

export const GET = (request: Request) => auth.handler(request);
