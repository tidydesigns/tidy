FROM oven/bun:1.3.14 AS bun
FROM node:22-bookworm-slim
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN npm install --global @openai/codex@0.160.0 && mkdir -p /var/lib/tidy-codex /app && chown node:node /var/lib/tidy-codex /app
WORKDIR /app
COPY --chown=node:node apps/web/agent-runner/ ./apps/web/agent-runner/
COPY --chown=node:node apps/web/lib/agents/execution-protocol.ts apps/web/lib/agents/protocol.ts ./apps/web/lib/agents/
USER node
ENV AGENT_RUNTIME_DIRECTORY=/var/lib/tidy-codex AGENT_RUNNER_HOST=0.0.0.0 AGENT_RUNNER_PORT=8790
EXPOSE 8790
CMD ["bun", "apps/web/agent-runner/main.ts"]
