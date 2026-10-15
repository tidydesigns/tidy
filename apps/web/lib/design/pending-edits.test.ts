import { expect, test } from "bun:test";
import { blankDesignDocument } from "./document";
import { RoomEditQueue, type RoomCommit } from "./room-edit-queue";

test("navigation remains guarded until every queued edit settles, including failed edits", async () => {
  const snapshot = { revision: 0, content: blankDesignDocument() };
  const queue = new RoomEditQueue(snapshot, () => {});
  let accept!: (result: RoomCommit) => void;
  let reject!: (error: Error) => void;
  expect(queue.hasPendingEdits).toBe(false);
  const first = queue.commit([], () => new Promise((resolve) => (accept = resolve)));
  const second = queue.commit([], () => new Promise((_, fail) => (reject = fail)));
  // The guard is synchronous, even before the first network request starts.
  expect(queue.hasPendingEdits).toBe(true);
  await Promise.resolve();
  await Promise.resolve();
  accept({ patch: [], snapshot, sequence: 0 });
  await first;
  expect(queue.hasPendingEdits).toBe(true);
  const failed = second.catch((error: unknown) => error);
  await Promise.resolve();
  await Promise.resolve();
  reject(new Error("Access ended"));
  expect(await failed).toBeInstanceOf(Error);
  expect(queue.hasPendingEdits).toBe(false);
});
