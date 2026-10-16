import { handleRequest } from "../../lib/request-boundary";
import { requestSignal, traceRequestPhase } from "../../lib/request-lifecycle";

let canceled = false;
const worker = {
  fetch(request: Request) {
    return handleRequest(
      request,
      async (bounded) => {
        const path = new URL(bounded.url).pathname;
        if (path === "/stall")
          return traceRequestPhase("auth_api", () => new Promise<Response>(() => {}));
        if (path === "/body-stall")
          return new Response(
            new ReadableStream({
              cancel() {
                canceled = true;
              },
              start(stream) {
                stream.enqueue(new TextEncoder().encode("<!doctype html><html>"));
              },
            }),
            { headers: { "content-type": "text/html" } },
          );
        if (path === "/sse")
          return new Response("data: ready\n\n", {
            headers: { "content-type": "text/event-stream" },
          });
        return Response.json({ active: !requestSignal()?.aborted, canceled });
      },
      50,
    );
  },
};
export default worker;
