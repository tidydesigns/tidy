import { parseDesignDocument, type DesignDocument } from "./document";

export type DocumentSnapshot = { revision: number; content: DesignDocument };
export class EditConflictError extends Error {
  constructor(path: string) {
    super(
      `The file changed elsewhere (${path}). Your edits are retained. Retry after reviewing the latest file.`,
    );
  }
}

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Three-way merge: a remote edit to a different property never gets overwritten. */
function merge(before: unknown, after: unknown, remote: unknown, path: string): unknown {
  if (equal(before, after)) return remote;
  if (equal(before, remote) || equal(after, remote)) return after;
  if (object(before) && object(after) && object(remote)) {
    const result: Record<string, unknown> = { ...remote };
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const value = merge(before[key], after[key], remote[key], `${path}.${key}`);
      if (value === undefined) delete result[key];
      else result[key] = value;
    }
    return result;
  }
  throw new EditConflictError(path);
}

function mergeNodes(
  before: DesignDocument["nodes"],
  after: DesignDocument["nodes"],
  remote: DesignDocument["nodes"],
) {
  const old = new Map(before.map((node) => [node.id, node]));
  const local = new Map(after.map((node) => [node.id, node]));
  const current = new Map(remote.map((node) => [node.id, node]));
  for (const id of new Set([...old.keys(), ...local.keys()])) {
    const result = merge(old.get(id), local.get(id), current.get(id), `layer ${id}`) as
      | DesignDocument["nodes"][number]
      | undefined;
    if (result) current.set(id, result);
    else current.delete(id);
  }
  const beforeOrder = before.map((node) => node.id).filter((id) => local.has(id));
  const afterOrder = after.map((node) => node.id).filter((id) => old.has(id));
  // Only claim ordering when this operation actually changes it.
  const reordered = !equal(beforeOrder, afterOrder);
  if (reordered) {
    const remoteOrder = remote.map((node) => node.id).filter((id) => old.has(id) && local.has(id));
    if (!equal(remoteOrder, beforeOrder) && !equal(remoteOrder, afterOrder))
      throw new EditConflictError("layer order");
  }
  const remoteOrderUnchanged = equal(
    before.map((node) => node.id),
    remote.map((node) => node.id),
  );
  const order =
    reordered || remoteOrderUnchanged
      ? [...after.map((node) => node.id), ...remote.map((node) => node.id)]
      : remote.map((node) => node.id);
  if (!reordered && !remoteOrderUnchanged)
    for (let index = 0; index < after.length; index++) {
      const id = after[index].id;
      if (order.includes(id)) continue;
      const next = after.slice(index + 1).find((node) => order.includes(node.id));
      if (next) order.splice(order.indexOf(next.id), 0, id);
      else order.push(id);
    }
  return [...new Set(order)].flatMap((id) => (current.has(id) ? [current.get(id)!] : []));
}

export function rebaseDocument(
  before: DesignDocument,
  after: DesignDocument,
  remote: DesignDocument,
): DesignDocument {
  return parseDesignDocument({
    ...(merge(
      { ...before, nodes: [], editedNodeIds: [], deletedSourceKeys: [] },
      { ...after, nodes: [], editedNodeIds: [], deletedSourceKeys: [] },
      { ...remote, nodes: [], editedNodeIds: [], deletedSourceKeys: [] },
      "document",
    ) as DesignDocument),
    nodes: mergeNodes(before.nodes, after.nodes, remote.nodes),
    editedNodeIds: [...new Set([...after.editedNodeIds, ...remote.editedNodeIds])],
    deletedSourceKeys: [
      ...new Map(
        [...after.deletedSourceKeys, ...remote.deletedSourceKeys].map((item) => [
          `${item.importKey}:${item.sourceKey}`,
          item,
        ]),
      ).values(),
    ],
  });
}

type Job = { before: DesignDocument; after: DesignDocument; resolve: (saved: boolean) => void };

/** Serial persistence with immediate local feedback; failures retain all unsaved work. */
export class DocumentEditQueue {
  private jobs: Job[] = [];
  private running = false;
  private failed = false;
  private confirmed: DocumentSnapshot;
  private optimistic: DocumentSnapshot;

  constructor(
    initial: DocumentSnapshot,
    private save: (snapshot: DocumentSnapshot) => Promise<DocumentSnapshot>,
    private onChange: (snapshot: DocumentSnapshot, pending: boolean) => void,
    private onError: (error: Error) => void,
  ) {
    this.confirmed = initial;
    this.optimistic = initial;
  }

  get current() {
    return this.optimistic;
  }
  get saved() {
    return this.confirmed;
  }
  get pending() {
    return this.jobs.length > 0;
  }

  receive(snapshot: DocumentSnapshot) {
    if (this.pending || this.running) return;
    this.confirmed = snapshot;
    this.optimistic = snapshot;
  }

  enqueue(content: DesignDocument): Promise<boolean> {
    const before = this.optimistic.content;
    if (equal(before, content)) return Promise.resolve(true);
    this.optimistic = { ...this.optimistic, content };
    const completion = new Promise<boolean>((resolve) => {
      this.jobs.push({ before, after: content, resolve });
    });
    this.onChange(this.optimistic, true);
    void this.drain();
    return completion;
  }

  retry() {
    this.failed = false;
    void this.drain();
  }

  discard(snapshot: DocumentSnapshot) {
    if (this.running) return;
    for (const job of this.jobs) job.resolve(false);
    this.jobs = [];
    this.failed = false;
    this.confirmed = snapshot;
    this.optimistic = snapshot;
    this.onChange(snapshot, false);
  }

  private async drain() {
    if (this.running || this.failed) return;
    this.running = true;
    try {
      while (this.jobs.length) {
        const job = this.jobs[0];
        const content = rebaseDocument(job.before, job.after, this.confirmed.content);
        const saved = await this.save({ revision: this.confirmed.revision, content });
        this.confirmed = saved;
        this.jobs.shift();
        job.resolve(true);
        let projected = saved.content;
        for (const pending of this.jobs)
          projected = rebaseDocument(pending.before, pending.after, projected);
        this.optimistic = { revision: saved.revision, content: projected };
        this.onChange(this.optimistic, this.pending);
      }
    } catch (cause) {
      this.failed = true;
      this.onError(cause instanceof Error ? cause : new Error("Could not apply edits."));
    } finally {
      this.running = false;
    }
  }
}
