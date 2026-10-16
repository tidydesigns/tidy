import { createErrorReporter } from "../../lib/posthog-server";

function failAtOriginalSource() {
  throw new Error("private-error-message-with-token", { cause: new Error("private-cause") });
}

const worker = {
  async fetch() {
    try {
      failAtOriginalSource();
    } catch (error) {
      await createErrorReporter({
        serverErrorsEnabled: "1",
        key: "synthetic-worker-project",
        host: "https://collector.invalid",
        release: "synthetic-release",
      })(error, { source: "next", event: "server_request_failed", route: "/api/mcp" });
    }
    return new Response("reported");
  },
};

export default worker;
