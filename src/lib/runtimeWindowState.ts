import type { Group, Tab } from "../types";
import {
  WINDOW_STATE_VERSION,
  collectWindowLayoutTabIds,
  validateWindowState,
  type LaunchSpecV1,
  type WindowEntryRefV1,
  type WindowStateV1,
  type WindowTabV1,
} from "./windowState";

export interface RuntimeWindowState {
  tabs: Tab[];
  groups: Group[];
  activeEntryId: string;
  activeLeafByGroup: Record<string, string>;
}

export function findActiveRuntimeTab(
  tabs: readonly Tab[],
  groups: readonly Group[],
  activeEntryId: string,
  activeLeafByGroup: Readonly<Record<string, string>>,
): Tab | undefined {
  const direct = tabs.find(tab => tab.id === activeEntryId && !tab.groupId);
  if (direct) return direct;
  const group = groups.find(candidate => candidate.id === activeEntryId);
  if (!group) return undefined;
  const leafIds = collectWindowLayoutTabIds(group.layout);
  const activeLeafId = activeLeafByGroup[group.id];
  const resolvedId = activeLeafId && leafIds.includes(activeLeafId)
    ? activeLeafId
    : leafIds[0];
  return tabs.find(tab => tab.id === resolvedId && tab.groupId === group.id);
}

export function launchFromRuntimeTab(tab: Tab): LaunchSpecV1 {
  if (tab.launch) return tab.launch;
  if (tab.shellMode === "raw") return { kind: "shell", shellId: tab.shellId || "default" };
  const agent = tab.agent || "claude";
  if (tab.sessionId) {
    return {
      kind: "session",
      agent,
      sessionId: tab.sessionId,
      ...(tab.shellId ? { hostShellId: tab.shellId } : {}),
    };
  }
  return { kind: "agent", agent, ...(tab.shellId ? { hostShellId: tab.shellId } : {}) };
}

export function runtimeTabFromWindow(tab: WindowTabV1, confirmCommands = true): Tab {
  const base: Tab = {
    ...(tab as WindowTabV1 & Partial<Tab>),
    type: "terminal",
    projectPath: tab.projectPath,
    launch: tab.launch,
  };
  if (tab.launch.kind === "session") {
    return {
      ...base,
      shellMode: "claude",
      sessionId: tab.launch.sessionId,
      agent: tab.launch.agent,
      shellId: tab.launch.hostShellId,
    };
  }
  if (tab.launch.kind === "agent") {
    return {
      ...base,
      shellMode: "claude",
      sessionId: undefined,
      agent: tab.launch.agent,
      shellId: tab.launch.hostShellId,
    };
  }
  if (tab.launch.kind === "shell") {
    return { ...base, shellMode: "raw", shellId: tab.launch.shellId, sessionId: undefined };
  }
  return {
    ...base,
    shellMode: "raw",
    shellId: tab.launch.shellId,
    sessionId: undefined,
    requiresLaunchConfirmation: confirmCommands,
  };
}

function orderedEntries(tabs: readonly Tab[], groups: readonly Group[]): WindowEntryRefV1[] {
  const groupsById = new Map(groups.map(group => [group.id, group]));
  const seen = new Set<string>();
  const entries: WindowEntryRefV1[] = [];
  for (const tab of tabs) {
    if (tab.groupId) {
      if (!seen.has(tab.groupId) && groupsById.has(tab.groupId)) {
        seen.add(tab.groupId);
        entries.push({ kind: "group", id: tab.groupId });
      }
    } else if (!seen.has(tab.id)) {
      seen.add(tab.id);
      entries.push({ kind: "tab", id: tab.id });
    }
  }
  for (const group of groups) {
    if (!seen.has(group.id)) entries.push({ kind: "group", id: group.id });
  }
  const pinned = entries.filter(entry => entry.kind === "group"
    ? groupsById.get(entry.id)?.pinned === true
    : tabs.find(tab => tab.id === entry.id)?.pinned === true);
  const unpinned = entries.filter(entry => !pinned.some(candidate => candidate.id === entry.id));
  return [...pinned, ...unpinned];
}

export function createWindowState(
  tabs: readonly Tab[],
  groups: readonly Group[],
  activeEntryId: string,
  activeLeafByGroup: Readonly<Record<string, string>>,
): WindowStateV1 {
  const entries = orderedEntries(tabs, groups);
  const entryIds = new Set(entries.map(entry => entry.id));
  const leaves: Record<string, string> = {};
  for (const group of groups) {
    const ids = collectWindowLayoutTabIds(group.layout);
    const requested = activeLeafByGroup[group.id];
    if (requested && ids.includes(requested)) leaves[group.id] = requested;
    else if (ids[0]) leaves[group.id] = ids[0];
  }
  return {
    version: WINDOW_STATE_VERSION,
    tabs: tabs.map(tab => ({
      ...tab,
      projectPath: tab.projectPath || "",
      launch: launchFromRuntimeTab(tab),
      ...(tab.groupId ? { pinned: undefined } : {}),
    })),
    groups: groups.map(group => ({ ...group })),
    entryOrder: entries,
    activeEntryId: activeEntryId === "home" || activeEntryId === "settings" || entryIds.has(activeEntryId)
      ? activeEntryId
      : entries[0]?.id || "home",
    activeLeafByGroup: leaves,
  };
}

export function decodeRuntimeWindowState(state: WindowStateV1, options: { confirmCommands?: boolean } = {}): RuntimeWindowState {
  const tabsById = new Map(state.tabs.map(tab => [tab.id, tab]));
  const groupsById = new Map(state.groups.map(group => [group.id, group]));
  const seen = new Set<string>();
  const orderedTabs: WindowTabV1[] = [];
  const append = (id: string) => {
    const tab = tabsById.get(id);
    if (tab && !seen.has(id)) {
      seen.add(id);
      orderedTabs.push(tab);
    }
  };
  for (const entry of state.entryOrder) {
    if (entry.kind === "tab") {
      append(entry.id);
      continue;
    }
    const group = groupsById.get(entry.id);
    if (group) collectWindowLayoutTabIds(group.layout).forEach(append);
  }
  // Valid states are fully covered above; preserve malformed-state diagnostics by
  // retaining any unlisted tabs for the caller's subsequent validation.
  state.tabs.forEach(tab => append(tab.id));
  return {
    tabs: orderedTabs.map(tab => runtimeTabFromWindow(tab, options.confirmCommands !== false)),
    groups: state.groups.map(group => ({ ...group, layout: group.layout })),
    activeEntryId: state.activeEntryId,
    activeLeafByGroup: { ...state.activeLeafByGroup },
  };
}

/** Retains trust prompts for mounted command tabs during unrelated atomic state edits. */
export function preservePendingCommandConfirmations(
  runtime: RuntimeWindowState,
  previousTabs: readonly Tab[],
): RuntimeWindowState {
  const pendingIds = new Set(
    previousTabs
      .filter(tab => tab.requiresLaunchConfirmation === true)
      .map(tab => tab.id),
  );
  if (pendingIds.size === 0) return runtime;
  return {
    ...runtime,
    tabs: runtime.tabs.map(tab => pendingIds.has(tab.id)
      ? { ...tab, requiresLaunchConfirmation: true }
      : tab),
  };
}

/** Reopened history entries receive fresh IDs, so their command tabs require fresh trust. */
export function requireConfirmationForNewCommandTabs(
  runtime: RuntimeWindowState,
  previousTabs: readonly Tab[],
): RuntimeWindowState {
  const previousIds = new Set(previousTabs.map(tab => tab.id));
  return {
    ...runtime,
    tabs: runtime.tabs.map(tab => !previousIds.has(tab.id) && tab.launch?.kind === "command"
      ? { ...tab, requiresLaunchConfirmation: true }
      : tab),
  };
}

export function filterStartupWindowState(state: WindowStateV1, restoreUnpinned: boolean): WindowStateV1 {
  if (restoreUnpinned) return state;
  const keptEntries = state.entryOrder.filter(entry => entry.kind === "group"
    ? state.groups.some(group => group.id === entry.id && group.pinned)
    : state.tabs.some(tab => tab.id === entry.id && !tab.groupId && tab.pinned));
  const keptEntryIds = new Set(keptEntries.map(entry => entry.id));
  const keptGroups = state.groups.filter(group => keptEntryIds.has(group.id));
  const keptGroupIds = new Set(keptGroups.map(group => group.id));
  const keptTabs = state.tabs.filter(tab => tab.groupId
    ? keptGroupIds.has(tab.groupId)
    : keptEntryIds.has(tab.id));
  const activeLeafByGroup: Record<string, string> = {};
  for (const group of keptGroups) {
    const active = state.activeLeafByGroup[group.id];
    if (active) activeLeafByGroup[group.id] = active;
  }
  return {
    ...state,
    tabs: keptTabs,
    groups: keptGroups,
    entryOrder: keptEntries,
    activeEntryId: keptEntryIds.has(state.activeEntryId) ? state.activeEntryId : keptEntries[0]?.id || "home",
    activeLeafByGroup,
  };
}

export function validateRuntimeWindowState(runtime: RuntimeWindowState) {
  return validateWindowState(createWindowState(
    runtime.tabs,
    runtime.groups,
    runtime.activeEntryId,
    runtime.activeLeafByGroup,
  ));
}
