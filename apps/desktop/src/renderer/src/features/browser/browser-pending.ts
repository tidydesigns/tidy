import type { BrowserState } from "../../../../shared/contracts/browser";

export type BrowserPending = {
  closed: Set<string>;
  selected: string | null;
  navigation: Map<string, { id: string; url: string }>;
};

export function projectBrowserState(state: BrowserState, pending: BrowserPending): BrowserState {
  const tabs = state.tabs
    .filter((tab) => !pending.closed.has(tab.id))
    .map((tab) => {
      const navigation = pending.navigation.get(tab.id);
      return navigation ? { ...tab, url: navigation.url, loading: true, error: null } : tab;
    });
  const requested = pending.selected ?? state.activeTabId;
  const activeTabId = tabs.some((tab) => tab.id === requested)
    ? requested
    : (tabs.at(-1)?.id ?? null);
  return { ...state, tabs, activeTabId };
}

export function confirmBrowserState(state: BrowserState, pending: BrowserPending) {
  for (const id of pending.closed)
    if (!state.tabs.some((tab) => tab.id === id)) pending.closed.delete(id);
  if (
    pending.selected &&
    (state.activeTabId === pending.selected ||
      !state.tabs.some((tab) => tab.id === pending.selected))
  )
    pending.selected = null;
  for (const [id, navigation] of pending.navigation) {
    const tab = state.tabs.find((tab) => tab.id === id);
    if (!tab || tab.url === navigation.url) pending.navigation.delete(id);
  }
  return projectBrowserState(state, pending);
}
