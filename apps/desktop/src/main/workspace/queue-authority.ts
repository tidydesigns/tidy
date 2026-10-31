import { createHash } from "node:crypto";
import { z } from "zod";
import type { Thread } from "../../shared/contracts/desktop";
import { queuedMessageSchema, type QueuedMessage } from "../../shared/contracts/message-queue";
import { effectivePermissionMode, permissionModeSchema } from "../../shared/contracts/permissions";
import { PrivateState } from "../platform/private-state";

const authoritySchema = z
  .object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    harness: z.enum(["codex", "claude", "opencode"]),
    permissionMode: permissionModeSchema,
  })
  .strict();
type QueueThread = Pick<Thread, "id" | "projectId" | "harness" | "settings">;

function fingerprint(message: QueuedMessage) {
  return createHash("sha256")
    .update(JSON.stringify(queuedMessageSchema.parse(message)))
    .digest("hex");
}

export class QueueAuthority {
  private state: PrivateState;
  constructor(directory: string) {
    this.state = new PrivateState(directory);
  }

  initialize() {
    return this.state.initialize();
  }

  private key(projectPath: string, thread: QueueThread, message: QueuedMessage) {
    return `queue-${createHash("sha256")
      .update(JSON.stringify([projectPath, thread.projectId, thread.id, message.id]))
      .digest("hex")}`;
  }

  private async read(key: string) {
    const stored = await this.state.read(key);
    return stored === undefined ? undefined : authoritySchema.parse(stored);
  }

  private matches(authority: z.infer<typeof authoritySchema>, message: QueuedMessage) {
    if (authority.fingerprint !== fingerprint(message))
      throw new Error(
        "This queued message changed outside Tidy. Remove it and write a new message.",
      );
  }

  async trust(projectPath: string, thread: QueueThread, message: QueuedMessage) {
    const key = this.key(projectPath, thread, message);
    const previous = await this.read(key);
    if (previous) {
      this.matches(previous, message);
      return;
    }
    const mode = effectivePermissionMode(thread.harness, thread.settings?.permissionMode);
    if (
      message.executionConstraint &&
      (message.executionConstraint.harness !== thread.harness ||
        message.executionConstraint.permissionMode !== mode)
    )
      throw new Error("This queued message requires the conversation's original permissions.");
    await this.state.write(key, {
      fingerprint: fingerprint(message),
      harness: thread.harness,
      permissionMode: mode,
    });
  }

  async edit(
    projectPath: string,
    thread: QueueThread,
    previous: QueuedMessage,
    next: QueuedMessage,
  ) {
    if (previous.id !== next.id)
      throw new Error("A queue edit cannot change the message identifier.");
    const key = this.key(projectPath, thread, previous);
    const authority = await this.read(key);
    if (!authority) {
      await this.trust(projectPath, thread, next);
      return;
    }
    this.matches(authority, previous);
    if (JSON.stringify(previous.executionConstraint) !== JSON.stringify(next.executionConstraint))
      throw new Error("A queue edit cannot change the message's original permissions.");
    await this.state.write(key, { ...authority, fingerprint: fingerprint(next) });
  }

  async verify(
    projectPath: string,
    thread: QueueThread,
    message: QueuedMessage,
    allowUntrusted = false,
  ) {
    const key = this.key(projectPath, thread, message);
    let authority = await this.read(key);
    if (!authority && allowUntrusted) {
      await this.trust(projectPath, thread, message);
      authority = await this.read(key);
    }
    if (!authority)
      throw new Error(
        "Review this imported queued message and send it explicitly before continuing.",
      );
    this.matches(authority, message);
    const mode = effectivePermissionMode(thread.harness, thread.settings?.permissionMode);
    const narrowed =
      !message.executionConstraint && thread.harness === "codex" && mode === "read-only";
    if (authority.harness !== thread.harness || (authority.permissionMode !== mode && !narrowed))
      throw new Error("This queued message requires the conversation's original permissions.");
  }
}
