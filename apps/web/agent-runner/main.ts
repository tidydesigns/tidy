import { isAbsolute } from "node:path";
import { AgentExecutor, executionClient } from "./executor";
import { createRunnerHandler } from "./server";

if (import.meta.main) {
  const secret = process.env.AGENT_RUNNER_SECRET;
  const directory = process.env.AGENT_RUNTIME_DIRECTORY;
  const tidyUrl = process.env.AGENT_TIDY_URL;
  if (!secret || !directory || !tidyUrl || !isAbsolute(directory))
    throw new Error(
      "Set AGENT_RUNNER_SECRET, AGENT_TIDY_URL and an absolute persistent AGENT_RUNTIME_DIRECTORY.",
    );
  const handler = createRunnerHandler({
    secret,
    directory,
    onRuntime: (owner, runtime) => executor.attach(owner, runtime),
  });
  const executor = new AgentExecutor(executionClient(tidyUrl, secret), handler.runtime);
  void executor.start();
  const server = Bun.serve({
    hostname: process.env.AGENT_RUNNER_HOST ?? "127.0.0.1",
    port: Number(process.env.AGENT_RUNNER_PORT ?? 8790),
    maxRequestBodySize: 1024 * 1024,
    fetch: handler.fetch,
  });
  const shutdown = () => {
    executor?.close();
    handler.close();
    void server.stop(true);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.log(`Tidy Codex runner listening on port ${server.port}.`);
}
