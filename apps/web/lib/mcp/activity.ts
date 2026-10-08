import { createHash, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import { db } from "@/lib/db";
import { publishAgentActivity } from "@/lib/realtime/server";
import {
  type ActivityDetails,
  type ActivityObserver,
  type ActivityPhase,
  type AgentActivity,
  agentActivitySchema,
  activityTerminal,
} from "@/lib/realtime/agent-activity";
import { resolveActivityScope, type ActivityScope } from "./activity-scope";
import { record, safeActivityText } from "./activity-summary";

const phases: Record<string, ActivityPhase> = {
  get_file: "reading",
  get_document: "reading",
  get_file_image: "reading",
  export_component: "reading",
  export_visual_preview: "reading",
  list_pull_request_reviews: "reading",
  get_review_context: "reading",
  list_review_feedback: "reading",
  get_review_image: "reading",
  create_import: "receiving",
  put_import_chunk: "receiving",
  put_asset: "receiving",
  import_web_capture: "receiving",
  validate_import: "validating",
  commit_import: "publishing",
  abort_import: "receiving",
  patch_document: "editing",
  add_frames: "editing",
  add_rectangles: "editing",
  rename_file: "editing",
  move_file: "editing",
  link_pull_request: "editing",
  upload_implementation_capture: "receiving",
  add_review_feedback: "editing",
  record_feedback_response: "editing",
};
type Actor = {
  userId: string;
  clientId: string;
  threadId?: string;
  agentId?: string;
  ownerName?: string;
};
type Backend = {
  resolve: typeof resolveActivityScope;
  publish: (activity: AgentActivity) => Promise<void>;
  name: (actor: Actor) => Promise<string>;
};
const backend: Backend = {
  resolve: resolveActivityScope,
  publish: publishAgentActivity,
  name: async ({ clientId }) => {
    return (
      (
        await db.query<{ name: string }>(
          `select coalesce(nullif("name", ''), 'Coding agent') as "name" from "oauthClient" where "clientId" = $1`,
          [clientId],
        )
      ).rows[0]?.name ?? "Coding agent"
    );
  },
};
const noObserver: ActivityObserver = async () => {};

export class McpActivity {
  private actorName?: Promise<string>;
  constructor(
    private actor: Actor,
    private services: Backend = backend,
  ) {}
  async run<T>(
    tool: string,
    input: Record<string, unknown>,
    operation: (observe: ActivityObserver) => Promise<T>,
  ): Promise<T> {
    if (!phases[tool]) return operation(noObserver);
    let scope: ActivityScope | null = null;
    try {
      scope = await this.services.resolve(this.actor.userId, input);
    } catch {
      /* Activity must not break an otherwise valid tool. */
    }
    const id = randomUUID();
    let version = 0,
      details: ActivityDetails = { ...scope },
      publishedAt = 0;
    let publishedPhase: ActivityPhase | undefined;
    // Routing fields are deliberately not copied into the public detail schema.
    delete (details as Record<string, unknown>).fileId;
    delete (details as Record<string, unknown>).importId;
    const observe: ActivityObserver = async (phase, next = {}) => {
      if (!scope) return;
      details = { ...details, ...next };
      if (
        phase === publishedPhase &&
        Date.now() - publishedAt < 250 &&
        !activityTerminal({ phase } as AgentActivity)
      )
        return;
      try {
        this.actorName ??= this.services.name(this.actor).catch(() => "Coding agent");
        const now = Date.now();
        const activity: AgentActivity = {
          ...details,
          id,
          version: version++,
          fileId: scope.fileId,
          importId: scope.importId,
          actorId: createHash("sha256")
            .update(JSON.stringify([this.actor.userId, this.actor.clientId]))
            .digest("hex")
            .slice(0, 32),
          threadId: this.actor.threadId,
          agentId: this.actor.agentId,
          ownerName: this.actor.ownerName,
          actorName: safeActivityText(await this.actorName, 80) || "Coding agent",
          tool,
          phase,
          updatedAt: now,
          expiresAt: now + (this.actor.agentId ? 15_000 : 60_000),
        };
        if (activityTerminal(activity)) activity.expiresAt = now + 30_000;
        // Keep a hard UTF-8 budget even for unusually long/non-ASCII source labels.
        if (new TextEncoder().encode(JSON.stringify(activity)).byteLength > 2048) {
          activity.sourcePaths = [];
          activity.sourceProject = undefined;
          activity.sourceRoute = undefined;
        }
        await this.services.publish(agentActivitySchema.parse(activity));
        publishedAt = now;
        publishedPhase = phase;
      } catch {
        /* A lost activity relay never changes the tool outcome. */
      }
    };
    await observe(phases[tool]);
    try {
      const value = await operation(observe);
      const result = record(value),
        data = record(result.structuredContent);
      if (result.isError === true) {
        await observe("failed");
        return value;
      }
      // Tools return structured data. Never parse text/asset bytes for instrumentation.
      if (!scope && typeof data.fileId === "string") {
        try {
          scope = await this.services.resolve(this.actor.userId, { file_id: data.fileId });
        } catch {
          /* Best effort. */
        }
      }
      if (scope && typeof data.importId === "string") scope.importId = data.importId;
      const summary: ActivityDetails = {};
      if (tool === "put_asset" && typeof data.assetId === "string") summary.assetCount = 1;
      const shapes = data.frames ?? data.rectangles;
      if (Array.isArray(shapes))
        summary.nodeIds = shapes
          .slice(0, 3)
          .flatMap((node) =>
            typeof record(node).id === "string" ? [record(node).id as string] : [],
          );
      for (const key of [
        "nodeCount",
        "assetCount",
        "warningCount",
        "issueCount",
        "revision",
      ] as const)
        if (typeof data[key] === "number") summary[key] = data[key] as number;
      if (typeof data.importedNodeCount === "number") summary.nodeCount = data.importedNodeCount;
      for (const key of ["nodeIds", "sourcePaths", "sourceProject", "sourceRoute"] as const)
        if (data[key] !== undefined) Object.assign(summary, { [key]: data[key] });
      if (Array.isArray(data.warnings)) summary.warningCount = data.warnings.length;
      const layout = record(data.layout);
      if (Array.isArray(layout.issues)) summary.issueCount = layout.issues.length;
      const finished: ActivityPhase =
        layout.valid === false
          ? "failed"
          : tool === "commit_import" || tool === "import_web_capture"
            ? "published"
            : tool === "abort_import"
              ? "aborted"
              : ["create_import", "put_import_chunk", "put_asset", "validate_import"].includes(tool)
                ? "staged"
                : "completed";
      await observe(finished, summary);
      return value;
    } catch (error) {
      await observe("failed");
      throw error;
    }
  }
}

/** Preserve SDK argument/context/return semantics while observing only named file tools. */
export function instrumentMcpServer(server: McpServer, activity: McpActivity) {
  type Handler = (...args: unknown[]) => Promise<unknown>;
  type Register = (name: string, config: unknown, callback: Handler) => unknown;
  const register = server.registerTool.bind(server) as Register;
  server.registerTool = ((name: string, config: unknown, callback: Handler) =>
    register(
      name,
      config,
      name === "import_web_capture"
        ? callback
        : (...args) => activity.run(name, record(args[0]), async () => callback(...args)),
    )) as McpServer["registerTool"];
  return server;
}
