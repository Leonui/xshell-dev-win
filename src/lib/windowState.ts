export const WINDOW_STATE_VERSION = 1 as const;
export const CLOSED_HISTORY_LIMIT = 20;
export const MAX_GROUP_TABS = 8;

export type WindowAgentId = "claude" | "codex" | "cursor" | "opencode" | "antigravity";

export type CommandSpecV1 =
  | { kind: "argv"; program: string; args: string[] }
  | { kind: "shell"; line: string };

export type LaunchSpecV1 =
  | { kind: "session"; agent: WindowAgentId; sessionId: string; hostShellId?: string }
  | { kind: "agent"; agent: WindowAgentId; hostShellId?: string }
  | { kind: "shell"; shellId: string }
  | {
      kind: "command";
      shellId: string;
      command: CommandSpecV1;
      env?: Record<string, string>;
      keepOpen?: boolean;
    };

export interface WindowTabV1 {
  id: string;
  title: string;
  customTitle?: string;
  projectPath: string;
  projectName?: string;
  launch: LaunchSpecV1;
  groupId?: string;
  pinned?: boolean;
  createdAt?: number;
  lastActiveAt?: number;
}

export interface WindowLayoutLeafV1 {
  kind: "leaf";
  tabId: string;
}

export interface WindowLayoutSplitV1 {
  kind: "split";
  direction: "col" | "row";
  children: [WindowLayoutNodeV1, WindowLayoutNodeV1];
  ratio: number;
}

export type WindowLayoutNodeV1 = WindowLayoutLeafV1 | WindowLayoutSplitV1;

export interface WindowGroupV1 {
  id: string;
  name: string;
  layout: WindowLayoutNodeV1;
  pinned?: boolean;
}

export type WindowEntryRefV1 =
  | { kind: "tab"; id: string }
  | { kind: "group"; id: string };

export interface WindowStateV1 {
  version: typeof WINDOW_STATE_VERSION;
  tabs: WindowTabV1[];
  groups: WindowGroupV1[];
  entryOrder: WindowEntryRefV1[];
  activeEntryId: "home" | "settings" | string;
  activeLeafByGroup: Record<string, string>;
}

export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
}

export type DecodeResult<T> =
  | { ok: true; value: T; migrated: boolean; warnings: string[] }
  | { ok: false; issues: ValidationIssue[] };

export type IdFactory = (scope: "tab" | "group" | "closed") => string;

const KNOWN_AGENTS = new Set<WindowAgentId>(["claude", "codex", "cursor", "opencode", "antigravity"]);
const RESERVED_ENV = new Set(["TERM_PROGRAM", "PATH", "PATHEXT"]);
let fallbackId = 0;

export const defaultIdFactory: IdFactory = (scope) => {
  const random = globalThis.crypto?.randomUUID?.();
  return `${scope}-${random ?? `${Date.now().toString(36)}-${++fallbackId}`}`;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function issue(issues: ValidationIssue[], code: string, path: string, message: string) {
  issues.push({ code, path, message });
}

export function validateLaunchSpec(value: unknown, path: string, issues: ValidationIssue[]): value is LaunchSpecV1 {
  if (!isRecord(value) || typeof value.kind !== "string") {
    issue(issues, "invalid_launch", path, "Launch spec must be an object with a kind.");
    return false;
  }
  if (value.kind === "session") {
    if (!KNOWN_AGENTS.has(value.agent as WindowAgentId)) issue(issues, "invalid_agent", `${path}.agent`, "Unknown agent.");
    if (!nonEmpty(value.sessionId)) issue(issues, "invalid_session", `${path}.sessionId`, "Session id is required.");
    if (value.hostShellId !== undefined && !nonEmpty(value.hostShellId)) issue(issues, "invalid_shell", `${path}.hostShellId`, "Host shell id cannot be empty.");
    return true;
  }
  if (value.kind === "agent") {
    if (!KNOWN_AGENTS.has(value.agent as WindowAgentId)) issue(issues, "invalid_agent", `${path}.agent`, "Unknown agent.");
    if (value.hostShellId !== undefined && !nonEmpty(value.hostShellId)) issue(issues, "invalid_shell", `${path}.hostShellId`, "Host shell id cannot be empty.");
    return true;
  }
  if (value.kind === "shell") {
    if (!nonEmpty(value.shellId)) issue(issues, "invalid_shell", `${path}.shellId`, "Shell id is required.");
    return true;
  }
  if (value.kind === "command") {
    if (!nonEmpty(value.shellId)) issue(issues, "invalid_shell", `${path}.shellId`, "Command recipes require an explicit shell.");
    const command = value.command;
    if (!isRecord(command) || (command.kind !== "argv" && command.kind !== "shell")) {
      issue(issues, "invalid_command", `${path}.command`, "Command must be an argv or shell command.");
    } else if (command.kind === "argv") {
      if (!nonEmpty(command.program)) issue(issues, "invalid_program", `${path}.command.program`, "Program is required.");
      if (!Array.isArray(command.args) || command.args.some(arg => typeof arg !== "string" || arg.includes("\0"))) {
        issue(issues, "invalid_args", `${path}.command.args`, "Arguments must be NUL-free strings.");
      }
    } else if (!nonEmpty(command.line) || command.line.includes("\0")) {
      issue(issues, "invalid_command_line", `${path}.command.line`, "Shell command line must be non-empty and NUL-free.");
    }
    if (value.env !== undefined) {
      if (!isRecord(value.env)) {
        issue(issues, "invalid_env", `${path}.env`, "Environment must be a string map.");
      } else {
        for (const [name, envValue] of Object.entries(value.env)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) issue(issues, "invalid_env_name", `${path}.env.${name}`, "Invalid environment variable name.");
          const normalizedName = name.toUpperCase();
          if (RESERVED_ENV.has(normalizedName) || normalizedName.startsWith("XSHELL_")) issue(issues, "reserved_env", `${path}.env.${name}`, `${name} is managed by xshell.`);
          if (typeof envValue !== "string" || envValue.includes("\0")) issue(issues, "invalid_env_value", `${path}.env.${name}`, "Environment values must be NUL-free strings.");
        }
      }
    }
    if (value.keepOpen !== undefined && typeof value.keepOpen !== "boolean") issue(issues, "invalid_keep_open", `${path}.keepOpen`, "keepOpen must be boolean.");
    return true;
  }
  issue(issues, "unknown_launch", `${path}.kind`, `Unknown launch kind: ${value.kind}`);
  return false;
}

function validateLayoutNode(value: unknown, path: string, issues: ValidationIssue[], leaves: string[]): value is WindowLayoutNodeV1 {
  if (!isRecord(value)) {
    issue(issues, "invalid_layout", path, "Layout node must be an object.");
    return false;
  }
  if (value.kind === "leaf") {
    if (!nonEmpty(value.tabId)) issue(issues, "invalid_layout_leaf", `${path}.tabId`, "Layout leaf requires a tab id.");
    else leaves.push(value.tabId);
    return true;
  }
  if (value.kind === "split") {
    if (value.direction !== "col" && value.direction !== "row") issue(issues, "invalid_split_direction", `${path}.direction`, "Split direction must be col or row.");
    if (typeof value.ratio !== "number" || !Number.isFinite(value.ratio) || value.ratio <= 0 || value.ratio >= 1) {
      issue(issues, "invalid_split_ratio", `${path}.ratio`, "Split ratio must be between zero and one.");
    }
    if (!Array.isArray(value.children) || value.children.length !== 2) {
      issue(issues, "invalid_split_children", `${path}.children`, "A split requires exactly two children.");
      return false;
    }
    validateLayoutNode(value.children[0], `${path}.children[0]`, issues, leaves);
    validateLayoutNode(value.children[1], `${path}.children[1]`, issues, leaves);
    return true;
  }
  issue(issues, "invalid_layout_kind", `${path}.kind`, "Layout kind must be leaf or split.");
  return false;
}

export function collectWindowLayoutTabIds(node: WindowLayoutNodeV1): string[] {
  return node.kind === "leaf"
    ? [node.tabId]
    : [...collectWindowLayoutTabIds(node.children[0]), ...collectWindowLayoutTabIds(node.children[1])];
}

export function mapWindowLayoutTabIds(node: WindowLayoutNodeV1, ids: ReadonlyMap<string, string>): WindowLayoutNodeV1 {
  if (node.kind === "leaf") return { kind: "leaf", tabId: ids.get(node.tabId) ?? node.tabId };
  return {
    kind: "split",
    direction: node.direction,
    ratio: node.ratio,
    children: [mapWindowLayoutTabIds(node.children[0], ids), mapWindowLayoutTabIds(node.children[1], ids)],
  };
}

export function cloneWindowLayout(node: WindowLayoutNodeV1): WindowLayoutNodeV1 {
  return mapWindowLayoutTabIds(node, new Map());
}

export function removeWindowLayoutTab(node: WindowLayoutNodeV1, tabId: string): WindowLayoutNodeV1 | null {
  if (node.kind === "leaf") return node.tabId === tabId ? null : node;
  const left = removeWindowLayoutTab(node.children[0], tabId);
  const right = removeWindowLayoutTab(node.children[1], tabId);
  if (!left) return right;
  if (!right) return left;
  return { ...node, children: [left, right] };
}

export function sessionLaunchKey(launch: LaunchSpecV1): string | null {
  return launch.kind === "session" ? `${launch.agent}:${launch.sessionId}` : null;
}

export function validateWindowState(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) return [{ code: "invalid_state", path: "$", message: "Window state must be an object." }];
  if (value.version !== WINDOW_STATE_VERSION) issue(issues, "unsupported_version", "$.version", `Expected version ${WINDOW_STATE_VERSION}.`);
  if (!Array.isArray(value.tabs)) issue(issues, "invalid_tabs", "$.tabs", "Tabs must be an array.");
  if (!Array.isArray(value.groups)) issue(issues, "invalid_groups", "$.groups", "Groups must be an array.");
  if (!Array.isArray(value.entryOrder)) issue(issues, "invalid_entry_order", "$.entryOrder", "Entry order must be an array.");
  if (!nonEmpty(value.activeEntryId)) issue(issues, "invalid_active_entry", "$.activeEntryId", "Active entry id is required.");
  if (!isRecord(value.activeLeafByGroup)) issue(issues, "invalid_active_leaves", "$.activeLeafByGroup", "Active leaves must be a map.");
  if (!Array.isArray(value.tabs) || !Array.isArray(value.groups) || !Array.isArray(value.entryOrder) || !isRecord(value.activeLeafByGroup)) return issues;

  const tabs = value.tabs as unknown[];
  const groups = value.groups as unknown[];
  const tabById = new Map<string, Record<string, unknown>>();
  const groupById = new Map<string, Record<string, unknown>>();
  const seenSessions = new Map<string, string>();

  tabs.forEach((raw, index) => {
    const path = `$.tabs[${index}]`;
    if (!isRecord(raw)) { issue(issues, "invalid_tab", path, "Tab must be an object."); return; }
    if (!nonEmpty(raw.id)) issue(issues, "invalid_tab_id", `${path}.id`, "Tab id is required.");
    else if (tabById.has(raw.id)) issue(issues, "duplicate_tab_id", `${path}.id`, `Duplicate tab id ${raw.id}.`);
    else tabById.set(raw.id, raw);
    if (!nonEmpty(raw.title)) issue(issues, "invalid_title", `${path}.title`, "Tab title is required.");
    if (typeof raw.projectPath !== "string") issue(issues, "invalid_project_path", `${path}.projectPath`, "Project path must be a string.");
    if (raw.customTitle !== undefined && !nonEmpty(raw.customTitle)) issue(issues, "invalid_custom_title", `${path}.customTitle`, "Custom title cannot be empty.");
    if (raw.groupId !== undefined && !nonEmpty(raw.groupId)) issue(issues, "invalid_group_ref", `${path}.groupId`, "Group id cannot be empty.");
    if (raw.pinned !== undefined && typeof raw.pinned !== "boolean") issue(issues, "invalid_pinned", `${path}.pinned`, "Pinned must be boolean.");
    if (raw.groupId && raw.pinned) issue(issues, "pinned_group_member", `${path}.pinned`, "Pin the group entry, not an individual group member.");
    const launchValid = validateLaunchSpec(raw.launch, `${path}.launch`, issues);
    if (launchValid) {
      const key = sessionLaunchKey(raw.launch as LaunchSpecV1);
      if (key && seenSessions.has(key)) issue(issues, "duplicate_session", `${path}.launch.sessionId`, `Session already belongs to tab ${seenSessions.get(key)}.`);
      else if (key && typeof raw.id === "string") seenSessions.set(key, raw.id);
    }
  });

  groups.forEach((raw, index) => {
    const path = `$.groups[${index}]`;
    if (!isRecord(raw)) { issue(issues, "invalid_group", path, "Group must be an object."); return; }
    if (!nonEmpty(raw.id)) issue(issues, "invalid_group_id", `${path}.id`, "Group id is required.");
    else if (groupById.has(raw.id) || tabById.has(raw.id)) issue(issues, "duplicate_group_id", `${path}.id`, `Duplicate or ambiguous group id ${raw.id}.`);
    else groupById.set(raw.id, raw);
    if (!nonEmpty(raw.name)) issue(issues, "invalid_group_name", `${path}.name`, "Group name is required.");
    if (raw.pinned !== undefined && typeof raw.pinned !== "boolean") issue(issues, "invalid_pinned", `${path}.pinned`, "Pinned must be boolean.");
    const leaves: string[] = [];
    validateLayoutNode(raw.layout, `${path}.layout`, issues, leaves);
    const uniqueLeaves = new Set(leaves);
    if (uniqueLeaves.size !== leaves.length) issue(issues, "duplicate_layout_leaf", `${path}.layout`, "A tab may appear only once in a group layout.");
    if (leaves.length < 2 || leaves.length > MAX_GROUP_TABS) issue(issues, "invalid_group_size", `${path}.layout`, `Groups require 2-${MAX_GROUP_TABS} tabs.`);
    if (typeof raw.id === "string") {
      const members = tabs.filter(tab => isRecord(tab) && tab.groupId === raw.id).map(tab => (tab as Record<string, unknown>).id).filter(nonEmpty);
      if (members.length !== leaves.length || members.some(id => !uniqueLeaves.has(id))) issue(issues, "group_membership_mismatch", path, "Group layout and tab groupId membership differ.");
      for (const leaf of leaves) {
        if (!tabById.has(leaf)) issue(issues, "missing_layout_tab", `${path}.layout`, `Layout references missing tab ${leaf}.`);
      }
    }
  });

  const seenEntries = new Set<string>();
  for (let index = 0; index < value.entryOrder.length; index++) {
    const raw = value.entryOrder[index];
    const path = `$.entryOrder[${index}]`;
    if (!isRecord(raw) || (raw.kind !== "tab" && raw.kind !== "group") || !nonEmpty(raw.id)) {
      issue(issues, "invalid_entry", path, "Entry must reference a tab or group.");
      continue;
    }
    if (seenEntries.has(raw.id)) issue(issues, "duplicate_entry", path, `Entry ${raw.id} appears more than once.`);
    seenEntries.add(raw.id);
    if (raw.kind === "tab") {
      const tab = tabById.get(raw.id);
      if (!tab) issue(issues, "missing_entry_tab", path, `Entry references missing tab ${raw.id}.`);
      else if (tab.groupId) issue(issues, "group_member_entry", path, "Grouped tabs cannot be top-level entries.");
    } else if (!groupById.has(raw.id)) issue(issues, "missing_entry_group", path, `Entry references missing group ${raw.id}.`);
  }
  for (const [id, tab] of tabById) if (!tab.groupId && !seenEntries.has(id)) issue(issues, "unlisted_tab", "$.entryOrder", `Standalone tab ${id} is missing from entry order.`);
  for (const id of groupById.keys()) if (!seenEntries.has(id)) issue(issues, "unlisted_group", "$.entryOrder", `Group ${id} is missing from entry order.`);

  const active = value.activeEntryId;
  if (typeof active === "string" && active !== "home" && active !== "settings" && !seenEntries.has(active)) {
    issue(issues, "missing_active_entry", "$.activeEntryId", `Active entry ${active} does not exist.`);
  }
  for (const [groupId, leafId] of Object.entries(value.activeLeafByGroup)) {
    const group = groupById.get(groupId);
    if (!group) { issue(issues, "stale_active_group", `$.activeLeafByGroup.${groupId}`, "Active leaf references a missing group."); continue; }
    const leaves = isRecord(group.layout) ? collectValidatedLeaves(group.layout) : [];
    if (typeof leafId !== "string" || !leaves.includes(leafId)) issue(issues, "invalid_active_leaf", `$.activeLeafByGroup.${groupId}`, "Active leaf is not in the group layout.");
  }
  return issues;
}

function collectValidatedLeaves(value: Record<string, unknown>): string[] {
  if (value.kind === "leaf" && typeof value.tabId === "string") return [value.tabId];
  if (value.kind === "split" && Array.isArray(value.children) && value.children.length === 2 && isRecord(value.children[0]) && isRecord(value.children[1])) {
    return [...collectValidatedLeaves(value.children[0]), ...collectValidatedLeaves(value.children[1])];
  }
  return [];
}

function parseLegacyLayout(value: unknown): WindowLayoutNodeV1 | null {
  const issues: ValidationIssue[] = [];
  const leaves: string[] = [];
  if (!validateLayoutNode(value, "$", issues, leaves) || issues.length > 0) return null;
  return value as WindowLayoutNodeV1;
}

export function migrateLegacyWindowState(value: unknown): DecodeResult<WindowStateV1> {
  if (!isRecord(value)) return { ok: false, issues: [{ code: "invalid_legacy_state", path: "$", message: "Legacy state must be an object." }] };
  const rawTabs = Array.isArray(value.open_tabs) ? value.open_tabs : Array.isArray(value.tabs) ? value.tabs : [];
  const rawGroups = Array.isArray(value.open_groups) ? value.open_groups : Array.isArray(value.groups) ? value.groups : [];
  const warnings: string[] = [];
  const tabs: WindowTabV1[] = [];
  const tabIds = new Set<string>();
  const sessions = new Set<string>();

  for (const raw of rawTabs) {
    if (!isRecord(raw) || !nonEmpty(raw.id) || !nonEmpty(raw.title)) { warnings.push("Skipped a malformed legacy tab."); continue; }
    if (tabIds.has(raw.id)) { warnings.push(`Skipped duplicate legacy tab ${raw.id}.`); continue; }
    const agent = KNOWN_AGENTS.has(raw.agent as WindowAgentId) ? raw.agent as WindowAgentId : "claude";
    let launch: LaunchSpecV1;
    if (raw.shellMode === "raw") {
      launch = { kind: "shell", shellId: nonEmpty(raw.shellId) ? raw.shellId : "default" };
    } else if (nonEmpty(raw.sessionId)) {
      launch = { kind: "session", agent, sessionId: raw.sessionId, ...(nonEmpty(raw.shellId) ? { hostShellId: raw.shellId } : {}) };
    } else {
      launch = { kind: "agent", agent, ...(nonEmpty(raw.shellId) ? { hostShellId: raw.shellId } : {}) };
    }
    const sessionKey = sessionLaunchKey(launch);
    if (sessionKey && sessions.has(sessionKey)) { warnings.push(`Skipped duplicate legacy session ${sessionKey}.`); continue; }
    if (sessionKey) sessions.add(sessionKey);
    tabIds.add(raw.id);
    tabs.push({
      id: raw.id,
      title: raw.title,
      ...(nonEmpty(raw.customTitle) ? { customTitle: raw.customTitle } : {}),
      projectPath: typeof raw.projectPath === "string" ? raw.projectPath : "",
      ...(typeof raw.projectName === "string" ? { projectName: raw.projectName } : {}),
      launch,
      ...(raw.pinned === true ? { pinned: true } : {}),
      ...(typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? { createdAt: raw.createdAt } : {}),
      ...(typeof raw.lastActiveAt === "number" && Number.isFinite(raw.lastActiveAt) ? { lastActiveAt: raw.lastActiveAt } : {}),
    });
  }

  const tabById = new Map(tabs.map(tab => [tab.id, tab]));
  const claimedTabs = new Set<string>();
  const groups: WindowGroupV1[] = [];
  const groupIds = new Set<string>();
  for (const raw of rawGroups) {
    if (!isRecord(raw) || !nonEmpty(raw.id) || !nonEmpty(raw.name) || groupIds.has(raw.id) || tabIds.has(raw.id)) { warnings.push("Skipped a malformed or duplicate legacy group."); continue; }
    const layout = parseLegacyLayout(raw.layout);
    if (!layout) { warnings.push(`Skipped group ${raw.id} with an invalid layout.`); continue; }
    const leaves = collectWindowLayoutTabIds(layout);
    if (leaves.length < 2 || leaves.length > MAX_GROUP_TABS || new Set(leaves).size !== leaves.length || leaves.some(id => !tabById.has(id) || claimedTabs.has(id))) {
      warnings.push(`Skipped group ${raw.id} because its membership could not be restored.`);
      continue;
    }
    leaves.forEach(id => claimedTabs.add(id));
    groupIds.add(raw.id);
    groups.push({ id: raw.id, name: raw.name, layout: cloneWindowLayout(layout), ...(raw.pinned === true ? { pinned: true } : {}) });
    for (const id of leaves) {
      const tab = tabById.get(id)!;
      tab.groupId = raw.id;
      delete tab.pinned;
    }
  }

  const entryOrder: WindowEntryRefV1[] = [];
  const listedGroups = new Set<string>();
  for (const tab of tabs) {
    if (tab.groupId) {
      if (!listedGroups.has(tab.groupId)) { entryOrder.push({ kind: "group", id: tab.groupId }); listedGroups.add(tab.groupId); }
    } else entryOrder.push({ kind: "tab", id: tab.id });
  }
  const state: WindowStateV1 = { version: WINDOW_STATE_VERSION, tabs, groups, entryOrder, activeEntryId: "home", activeLeafByGroup: {} };
  const issues = validateWindowState(state);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: state, migrated: true, warnings };
}

export function decodeWindowState(value: unknown): DecodeResult<WindowStateV1> {
  if (isRecord(value) && value.version === WINDOW_STATE_VERSION) {
    const issues = validateWindowState(value);
    return issues.length > 0
      ? { ok: false, issues }
      : { ok: true, value: value as unknown as WindowStateV1, migrated: false, warnings: [] };
  }
  return migrateLegacyWindowState(value);
}

export interface ClosedTabRecordV1 {
  version: 1;
  kind: "tab";
  id: string;
  closedAt: number;
  entryIndex: number;
  tab: WindowTabV1;
}

export interface ClosedGroupRecordV1 {
  version: 1;
  kind: "group";
  id: string;
  closedAt: number;
  entryIndex: number;
  group: WindowGroupV1;
  tabs: WindowTabV1[];
  activeLeafId?: string;
}

export interface ClosedPaneRecordV1 {
  version: 1;
  kind: "pane";
  id: string;
  closedAt: number;
  entryIndex: number;
  removedTabId: string;
  group: WindowGroupV1;
  tabs: WindowTabV1[];
  activeLeafId?: string;
}

export type ClosedRecordV1 = ClosedTabRecordV1 | ClosedGroupRecordV1 | ClosedPaneRecordV1;

export interface StateTransitionSuccess {
  ok: true;
  state: WindowStateV1;
  history: ClosedRecordV1[];
  record?: ClosedRecordV1;
}

export interface StateTransitionFailure {
  ok: false;
  code: "not_found" | "pinned" | "invalid_state" | "empty_history" | "conflict";
  message: string;
  state: WindowStateV1;
  history: ClosedRecordV1[];
}

export type StateTransitionResult = StateTransitionSuccess | StateTransitionFailure;

export function pushClosedRecord(history: readonly ClosedRecordV1[], record: ClosedRecordV1, limit = CLOSED_HISTORY_LIMIT): ClosedRecordV1[] {
  if (limit <= 0) return [];
  return [...history, record].slice(-limit);
}

export function isWindowEntryPinned(state: WindowStateV1, entryId: string): boolean {
  return state.groups.find(group => group.id === entryId)?.pinned === true
    || state.tabs.find(tab => tab.id === entryId && !tab.groupId)?.pinned === true;
}

function snapshotTab(tab: WindowTabV1): WindowTabV1 {
  return { ...tab, launch: cloneLaunch(tab.launch) };
}

function cloneLaunch(launch: LaunchSpecV1): LaunchSpecV1 {
  if (launch.kind !== "command") return { ...launch };
  return {
    ...launch,
    command: launch.command.kind === "argv" ? { ...launch.command, args: [...launch.command.args] } : { ...launch.command },
    ...(launch.env ? { env: { ...launch.env } } : {}),
  };
}

function nextActiveEntry(state: WindowStateV1, removedId: string, removedIndex: number, nextOrder: WindowEntryRefV1[]): string {
  if (state.activeEntryId !== removedId) return state.activeEntryId;
  return nextOrder[Math.min(removedIndex, nextOrder.length - 1)]?.id ?? "home";
}

function failure(state: WindowStateV1, history: ClosedRecordV1[], code: StateTransitionFailure["code"], message: string): StateTransitionFailure {
  return { ok: false, code, message, state, history };
}

export function closeWindowEntry(
  state: WindowStateV1,
  history: ClosedRecordV1[],
  entryId: string,
  options: { now?: number; idFactory?: IdFactory; historyLimit?: number } = {},
): StateTransitionResult {
  const invalid = validateWindowState(state);
  if (invalid.length > 0) return failure(state, history, "invalid_state", invalid[0].message);
  const entryIndex = state.entryOrder.findIndex(entry => entry.id === entryId);
  if (entryIndex < 0) return failure(state, history, "not_found", `Entry ${entryId} does not exist.`);
  if (isWindowEntryPinned(state, entryId)) return failure(state, history, "pinned", "Pinned entries must be unpinned before closing.");
  const factory = options.idFactory ?? defaultIdFactory;
  const base = { version: 1 as const, id: factory("closed"), closedAt: options.now ?? Date.now(), entryIndex };
  const nextOrder = state.entryOrder.filter(entry => entry.id !== entryId);
  const group = state.groups.find(candidate => candidate.id === entryId);
  let record: ClosedRecordV1;
  let nextState: WindowStateV1;
  if (group) {
    const memberIds = new Set(collectWindowLayoutTabIds(group.layout));
    record = {
      ...base,
      kind: "group",
      group: { ...group, layout: cloneWindowLayout(group.layout) },
      tabs: state.tabs.filter(tab => memberIds.has(tab.id)).map(snapshotTab),
      ...(state.activeLeafByGroup[group.id] ? { activeLeafId: state.activeLeafByGroup[group.id] } : {}),
    };
    const activeLeafByGroup = { ...state.activeLeafByGroup };
    delete activeLeafByGroup[group.id];
    nextState = {
      ...state,
      tabs: state.tabs.filter(tab => !memberIds.has(tab.id)),
      groups: state.groups.filter(candidate => candidate.id !== group.id),
      entryOrder: nextOrder,
      activeEntryId: nextActiveEntry(state, entryId, entryIndex, nextOrder),
      activeLeafByGroup,
    };
  } else {
    const tab = state.tabs.find(candidate => candidate.id === entryId && !candidate.groupId);
    if (!tab) return failure(state, history, "not_found", `Standalone tab ${entryId} does not exist.`);
    record = { ...base, kind: "tab", tab: snapshotTab(tab) };
    nextState = {
      ...state,
      tabs: state.tabs.filter(candidate => candidate.id !== tab.id),
      entryOrder: nextOrder,
      activeEntryId: nextActiveEntry(state, entryId, entryIndex, nextOrder),
    };
  }
  return { ok: true, state: nextState, history: pushClosedRecord(history, record, options.historyLimit), record };
}

export function closeWindowPane(
  state: WindowStateV1,
  history: ClosedRecordV1[],
  tabId: string,
  options: { now?: number; idFactory?: IdFactory; historyLimit?: number } = {},
): StateTransitionResult {
  const invalid = validateWindowState(state);
  if (invalid.length > 0) return failure(state, history, "invalid_state", invalid[0].message);
  const tab = state.tabs.find(candidate => candidate.id === tabId);
  const group = tab?.groupId ? state.groups.find(candidate => candidate.id === tab.groupId) : undefined;
  if (!tab || !group) return failure(state, history, "not_found", `Grouped pane ${tabId} does not exist.`);
  if (group.pinned) return failure(state, history, "pinned", "A pane in a pinned group cannot be closed.");
  const entryIndex = state.entryOrder.findIndex(entry => entry.kind === "group" && entry.id === group.id);
  if (entryIndex < 0) return failure(state, history, "invalid_state", "Group is missing from entry order.");
  const factory = options.idFactory ?? defaultIdFactory;
  const groupTabIds = new Set(collectWindowLayoutTabIds(group.layout));
  const record: ClosedPaneRecordV1 = {
    version: 1,
    kind: "pane",
    id: factory("closed"),
    closedAt: options.now ?? Date.now(),
    entryIndex,
    removedTabId: tab.id,
    group: { ...group, layout: cloneWindowLayout(group.layout) },
    tabs: state.tabs.filter(candidate => groupTabIds.has(candidate.id)).map(snapshotTab),
    ...(state.activeLeafByGroup[group.id] ? { activeLeafId: state.activeLeafByGroup[group.id] } : {}),
  };
  const nextLayout = removeWindowLayoutTab(group.layout, tab.id);
  if (!nextLayout) return failure(state, history, "invalid_state", "Closing the pane would leave an empty group.");
  const survivors = collectWindowLayoutTabIds(nextLayout);
  const activeLeafByGroup = { ...state.activeLeafByGroup };
  let groups: WindowGroupV1[];
  let tabs = state.tabs.filter(candidate => candidate.id !== tab.id);
  let entryOrder = state.entryOrder;
  let activeEntryId = state.activeEntryId;
  if (survivors.length === 1) {
    const survivorId = survivors[0];
    tabs = tabs.map(candidate => candidate.id === survivorId ? { ...candidate, groupId: undefined } : candidate);
    groups = state.groups.filter(candidate => candidate.id !== group.id);
    entryOrder = state.entryOrder.map(entry => entry.kind === "group" && entry.id === group.id ? { kind: "tab" as const, id: survivorId } : entry);
    if (activeEntryId === group.id) activeEntryId = survivorId;
    delete activeLeafByGroup[group.id];
  } else {
    groups = state.groups.map(candidate => candidate.id === group.id ? { ...candidate, layout: nextLayout } : candidate);
    if (activeLeafByGroup[group.id] === tab.id) activeLeafByGroup[group.id] = survivors[0];
  }
  const nextState: WindowStateV1 = { ...state, tabs, groups, entryOrder, activeEntryId, activeLeafByGroup };
  return { ok: true, state: nextState, history: pushClosedRecord(history, record, options.historyLimit), record };
}

function allocateFreshId(scope: "tab" | "group", used: Set<string>, factory: IdFactory): string | null {
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = factory(scope);
    if (nonEmpty(candidate) && !used.has(candidate)) { used.add(candidate); return candidate; }
  }
  return null;
}

function hasSessionConflict(state: WindowStateV1, tabs: readonly WindowTabV1[]): string | null {
  const existing = new Set(state.tabs.map(tab => sessionLaunchKey(tab.launch)).filter(nonEmpty));
  const incoming = new Set<string>();
  for (const tab of tabs) {
    const key = sessionLaunchKey(tab.launch);
    if (!key) continue;
    if (existing.has(key) || incoming.has(key)) return key;
    incoming.add(key);
  }
  return null;
}

function insertEntry(order: WindowEntryRefV1[], index: number, entry: WindowEntryRefV1): WindowEntryRefV1[] {
  const next = [...order];
  next.splice(Math.max(0, Math.min(index, next.length)), 0, entry);
  return next;
}

function remapClosedRecord(
  record: ClosedRecordV1,
  tabIds: ReadonlyMap<string, string>,
  groupIds: ReadonlyMap<string, string>,
): ClosedRecordV1 {
  const remapTab = (tab: WindowTabV1): WindowTabV1 => ({
    ...snapshotTab(tab),
    id: tabIds.get(tab.id) ?? tab.id,
    ...(tab.groupId ? { groupId: groupIds.get(tab.groupId) ?? tab.groupId } : {}),
  });
  const remapGroup = (group: WindowGroupV1): WindowGroupV1 => ({
    ...group,
    id: groupIds.get(group.id) ?? group.id,
    layout: mapWindowLayoutTabIds(group.layout, tabIds),
  });
  if (record.kind === "tab") {
    return { ...record, tab: remapTab(record.tab) };
  }
  const shared = {
    ...record,
    group: remapGroup(record.group),
    tabs: record.tabs.map(remapTab),
    ...(record.activeLeafId ? { activeLeafId: tabIds.get(record.activeLeafId) ?? record.activeLeafId } : {}),
  };
  return record.kind === "pane"
    ? { ...shared, kind: "pane", removedTabId: tabIds.get(record.removedTabId) ?? record.removedTabId }
    : { ...shared, kind: "group" };
}

export function undoLastClosed(
  state: WindowStateV1,
  history: ClosedRecordV1[],
  options: { idFactory?: IdFactory } = {},
): StateTransitionResult {
  const invalid = validateWindowState(state);
  if (invalid.length > 0) return failure(state, history, "invalid_state", invalid[0].message);
  const record = history[history.length - 1];
  if (!record) return failure(state, history, "empty_history", "There is no recently closed entry.");
  const factory = options.idFactory ?? defaultIdFactory;
  const used = new Set([...state.tabs.map(tab => tab.id), ...state.groups.map(group => group.id)]);
  const restoredTabIds = new Map<string, string>();
  const restoredGroupIds = new Map<string, string>();
  let nextState: WindowStateV1;

  if (record.kind === "tab") {
    const conflict = hasSessionConflict(state, [record.tab]);
    if (conflict) return failure(state, history, "conflict", `Session ${conflict} is already open.`);
    const id = allocateFreshId("tab", used, factory);
    if (!id) return failure(state, history, "conflict", "Could not allocate a fresh tab id.");
    restoredTabIds.set(record.tab.id, id);
    const tab = { ...snapshotTab(record.tab), id, groupId: undefined, pinned: false };
    nextState = {
      ...state,
      tabs: [...state.tabs, tab],
      entryOrder: insertEntry(state.entryOrder, record.entryIndex, { kind: "tab", id }),
      activeEntryId: id,
    };
  } else if (record.kind === "group") {
    const conflict = hasSessionConflict(state, record.tabs);
    if (conflict) return failure(state, history, "conflict", `Session ${conflict} is already open.`);
    const groupId = allocateFreshId("group", used, factory);
    if (!groupId) return failure(state, history, "conflict", "Could not allocate a fresh group id.");
    restoredGroupIds.set(record.group.id, groupId);
    for (const tab of record.tabs) {
      const id = allocateFreshId("tab", used, factory);
      if (!id) return failure(state, history, "conflict", "Could not allocate fresh tab ids.");
      restoredTabIds.set(tab.id, id);
    }
    const tabs = record.tabs.map(tab => ({ ...snapshotTab(tab), id: restoredTabIds.get(tab.id)!, groupId, pinned: undefined }));
    const group: WindowGroupV1 = { ...record.group, id: groupId, pinned: false, layout: mapWindowLayoutTabIds(record.group.layout, restoredTabIds) };
    const activeLeafByGroup = { ...state.activeLeafByGroup };
    const activeLeaf = record.activeLeafId ? restoredTabIds.get(record.activeLeafId) : collectWindowLayoutTabIds(group.layout)[0];
    if (activeLeaf) activeLeafByGroup[groupId] = activeLeaf;
    nextState = {
      ...state,
      tabs: [...state.tabs, ...tabs],
      groups: [...state.groups, group],
      entryOrder: insertEntry(state.entryOrder, record.entryIndex, { kind: "group", id: groupId }),
      activeEntryId: groupId,
      activeLeafByGroup,
    };
  } else {
    const removed = record.tabs.find(tab => tab.id === record.removedTabId);
    if (!removed) return failure(state, history, "conflict", "Closed pane snapshot is incomplete.");
    const conflict = hasSessionConflict(state, [removed]);
    if (conflict) return failure(state, history, "conflict", `Session ${conflict} is already open.`);
    const survivorSnapshots = record.tabs.filter(tab => tab.id !== record.removedTabId);
    const survivors = survivorSnapshots.map(snapshot => state.tabs.find(tab => tab.id === snapshot.id));
    if (survivors.some(tab => !tab)) return failure(state, history, "conflict", "The group changed after the pane was closed.");
    const liveGroup = state.groups.find(group => group.id === record.group.id);
    if (liveGroup) {
      if (survivors.some(tab => tab!.groupId !== liveGroup.id)) return failure(state, history, "conflict", "The group membership changed after the pane was closed.");
    } else if (survivors.length !== 1 || survivors[0]!.groupId) {
      return failure(state, history, "conflict", "The dissolved group can no longer be reconstructed safely.");
    }
    const removedId = allocateFreshId("tab", used, factory);
    if (!removedId) return failure(state, history, "conflict", "Could not allocate a fresh tab id.");
    const groupId = liveGroup?.id ?? allocateFreshId("group", used, factory);
    if (!groupId) return failure(state, history, "conflict", "Could not allocate a fresh group id.");
    for (const tab of record.tabs) restoredTabIds.set(tab.id, tab.id);
    restoredTabIds.set(record.removedTabId, removedId);
    restoredGroupIds.set(record.group.id, groupId);
    const group: WindowGroupV1 = { ...record.group, id: groupId, pinned: false, layout: mapWindowLayoutTabIds(record.group.layout, restoredTabIds) };
    const removedTab = { ...snapshotTab(removed), id: removedId, groupId, pinned: undefined };
    const survivorIds = new Set(survivors.map(tab => tab!.id));
    const tabs = state.tabs.map(tab => survivorIds.has(tab.id) ? { ...tab, groupId, pinned: undefined } : tab);
    const groups = liveGroup ? state.groups.map(candidate => candidate.id === liveGroup.id ? group : candidate) : [...state.groups, group];
    let entryOrder = state.entryOrder;
    if (!liveGroup) {
      entryOrder = entryOrder.filter(entry => !(entry.kind === "tab" && survivorIds.has(entry.id)));
      entryOrder = insertEntry(entryOrder, record.entryIndex, { kind: "group", id: groupId });
    }
    const activeLeafByGroup = { ...state.activeLeafByGroup };
    if (!liveGroup) delete activeLeafByGroup[record.group.id];
    const activeLeaf = record.activeLeafId === record.removedTabId ? removedId : record.activeLeafId;
    activeLeafByGroup[groupId] = activeLeaf && collectWindowLayoutTabIds(group.layout).includes(activeLeaf) ? activeLeaf : collectWindowLayoutTabIds(group.layout)[0];
    nextState = { ...state, tabs: [...tabs, removedTab], groups, entryOrder, activeEntryId: groupId, activeLeafByGroup };
  }

  const nextIssues = validateWindowState(nextState);
  if (nextIssues.length > 0) return failure(state, history, "conflict", `Restore would create invalid state: ${nextIssues[0].message}`);
  const remainingHistory = history
    .slice(0, -1)
    .map(older => remapClosedRecord(older, restoredTabIds, restoredGroupIds));
  return { ok: true, state: nextState, history: remainingHistory };
}
