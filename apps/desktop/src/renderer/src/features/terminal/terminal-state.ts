import { z } from "zod";

export type TerminalTab = { id: string; projectId: string; title: string };
export type ProjectTerminals = {
  tabs: TerminalTab[];
  selected: string | null;
  open: boolean;
  next: number;
};
export const terminalStateSchema = z
  .record(
    z.uuid(),
    z.object({
      tabs: z
        .array(z.object({ id: z.uuid(), projectId: z.uuid(), title: z.string().max(100) }))
        .max(16),
      selected: z.uuid().nullable(),
      open: z.boolean(),
      next: z.number().int().positive().safe(),
    }),
  )
  .refine(
    (state) =>
      Object.values(state).reduce((count, value) => count + value.tabs.length, 0) <= 16 &&
      Object.entries(state).every(
        ([id, value]) =>
          value.tabs.every((tab) => tab.projectId === id) &&
          (value.tabs.length === 0
            ? value.selected === null
            : value.tabs.some((tab) => tab.id === value.selected)),
      ),
  );
export type TerminalState = Record<string, ProjectTerminals>;
export const emptyTerminals: ProjectTerminals = { tabs: [], selected: null, open: false, next: 1 };
export type TerminalAction =
  | { kind: "restore"; projectId: string; tab: TerminalTab; index: number }
  | { kind: "new"; projectId: string; id: string }
  | { kind: "show" | "hide"; projectId: string }
  | { kind: "select" | "close"; projectId: string; id: string }
  | { kind: "title"; projectId: string; id: string; title: string }
  | { kind: "prune"; projects: string[] };

export function terminalState(state: TerminalState, action: TerminalAction): TerminalState {
  if (action.kind === "prune") {
    const known = new Set(action.projects);
    return Object.keys(state).every((id) => known.has(id))
      ? state
      : Object.fromEntries(Object.entries(state).filter(([id]) => known.has(id)));
  }
  const previous = state[action.projectId] ?? emptyTerminals;
  let next: ProjectTerminals;
  switch (action.kind) {
    case "restore": {
      if (!state[action.projectId] || previous.tabs.some((tab) => tab.id === action.tab.id))
        return state;
      const tabs = [...previous.tabs];
      tabs.splice(action.index, 0, action.tab);
      next = { ...previous, tabs, selected: previous.selected ?? action.tab.id };
      break;
    }
    case "new":
      next = {
        tabs: [
          ...previous.tabs,
          { id: action.id, projectId: action.projectId, title: `Terminal ${previous.next}` },
        ],
        selected: action.id,
        open: true,
        next: previous.next + 1,
      };
      break;
    case "show":
      next = { ...previous, open: previous.tabs.length > 0 };
      break;
    case "hide":
      next = { ...previous, open: false };
      break;
    case "select":
      if (!previous.tabs.some((tab) => tab.id === action.id)) return state;
      next = { ...previous, selected: action.id, open: true };
      break;
    case "close": {
      const index = previous.tabs.findIndex((tab) => tab.id === action.id);
      if (index < 0) return state;
      const tabs = previous.tabs.filter((tab) => tab.id !== action.id);
      next = {
        ...previous,
        tabs,
        open: previous.open && tabs.length > 0,
        selected:
          previous.selected === action.id
            ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null)
            : previous.selected,
      };
      break;
    }
    case "title": {
      const title = action.title
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, 100);
      if (!title || !previous.tabs.some((tab) => tab.id === action.id && tab.title !== title))
        return state;
      next = {
        ...previous,
        tabs: previous.tabs.map((tab) => (tab.id === action.id ? { ...tab, title } : tab)),
      };
      break;
    }
  }
  return { ...state, [action.projectId]: next };
}
