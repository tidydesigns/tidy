import { expect, test } from "bun:test";
import type { ProjectSnapshot, ThreadSummary } from "../../../../shared/contracts/desktop";
import { createThreadRecoveryState } from "./thread-recovery-state";

const projectId = crypto.randomUUID();
const thread: ThreadSummary = {
  id: crypto.randomUUID(),
  projectId,
  revision: 4,
  title: "Limited",
  harness: "codex",
  designIds: [],
  status: "failed",
  errorKind: "usage-limit",
  updatedAt: new Date().toISOString(),
};
const snapshot = (threads: ThreadSummary[]): ProjectSnapshot => ({
  project: {
    id: projectId,
    name: "Project",
    path: "/fixture/project",
    openedAt: new Date().toISOString(),
  },
  threads,
  designs: [],
  folders: [],
});
const row = (revision = thread.revision) => ({ id: thread.id, projectId, revision, limited: true });

test("failed optimistic completion restores the notice without accepting stale host events", () => {
  const state = createThreadRecoveryState();
  state.snapshot(snapshot([thread]), {});
  const optimistic = { ...thread, revision: 5, doneAt: new Date().toISOString() };
  state.snapshot(snapshot([optimistic]), { [thread.id]: true });
  expect(state.limited.get(thread.id)?.hidden).toBe(true);
  state.snapshot(snapshot([thread]), {});
  expect(state.limited.get(thread.id)?.hidden).toBe(false);
  expect(state.receive({ ...thread, revision: 3, status: "running" })).toBe(false);
  expect(state.limited.has(thread.id)).toBe(true);
  state.snapshot(snapshot([optimistic]), { [thread.id]: true });
  state.receive({ ...thread, revision: 6, status: "running" });
  state.snapshot(snapshot([thread]), {});
  expect(state.limited.has(thread.id)).toBe(false);
});

test("snapshot omissions remove stale notices but preserve events newer than the previous snapshot", () => {
  const state = createThreadRecoveryState();
  state.snapshot(snapshot([thread]), {});
  state.snapshot(snapshot([]), {});
  expect(state.limited.size).toBe(0);
  state.snapshot(snapshot([thread]), {});
  state.receive({ ...thread, revision: 5 });
  state.snapshot(snapshot([]), {});
  expect(state.limited.get(thread.id)?.revision).toBe(5);
});

test("eligibility read omissions cannot erase failures received while discovery is in flight", () => {
  const state = createThreadRecoveryState();
  state.receive(thread);
  const baseline = state.capture(projectId);
  state.receive({ ...thread, revision: 5 });
  state.reconcile(projectId, [], baseline);
  expect(state.limited.get(thread.id)?.revision).toBe(5);
  state.reconcile(projectId, [], state.capture(projectId));
  expect(state.limited.size).toBe(0);
});

test("skipped work stays actionable until the host confirms it is no longer limited", () => {
  const state = createThreadRecoveryState();
  state.receive(thread);
  state.reconcile(projectId, [row()], state.capture(projectId));
  expect(state.limited.has(thread.id)).toBe(true);
  state.reconcile(projectId, [{ ...row(5), limited: false }], state.capture(projectId));
  expect(state.limited.size).toBe(0);
});

test("discovery cannot undo an optimistic completion or its preserved dismissal", () => {
  const state = createThreadRecoveryState();
  state.receive(thread);
  state.limited.get(thread.id)!.dismissed = true;
  state.snapshot(snapshot([{ ...thread, revision: 5, doneAt: new Date().toISOString() }]), {
    [thread.id]: true,
  });
  state.reconcile(projectId, [row()], state.capture(projectId));
  expect(state.limited.get(thread.id)?.hidden).toBe(true);
  state.snapshot(snapshot([thread]), {});
  expect(state.limited.get(thread.id)?.hidden).toBe(false);
  expect(state.limited.get(thread.id)?.dismissed).toBe(true);
});

test("an older discovery read cannot undo an optimistic reopen, but newer host state wins", () => {
  const state = createThreadRecoveryState();
  state.snapshot(snapshot([{ ...thread, doneAt: new Date().toISOString() }]), {});
  state.snapshot(snapshot([{ ...thread, revision: 5 }]), { [thread.id]: true });
  state.reconcile(projectId, [{ ...row(), limited: false }], state.capture(projectId));
  expect(state.limited.has(thread.id)).toBe(true);
  state.reconcile(projectId, [{ ...row(6), limited: false }], state.capture(projectId));
  state.snapshot(snapshot([thread]), {});
  expect(state.limited.has(thread.id)).toBe(false);
});
