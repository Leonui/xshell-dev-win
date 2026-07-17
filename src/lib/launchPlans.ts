import {
  MAX_GROUP_TABS,
  WINDOW_STATE_VERSION,
  cloneWindowLayout,
  collectWindowLayoutTabIds,
  defaultIdFactory,
  mapWindowLayoutTabIds,
  sessionLaunchKey,
  validateLaunchSpec,
  validateWindowState,
  type DecodeResult,
  type IdFactory,
  type LaunchSpecV1,
  type ValidationIssue,
  type WindowAgentId,
  type WindowEntryRefV1,
  type WindowGroupV1,
  type WindowLayoutNodeV1,
  type WindowStateV1,
  type WindowTabV1,
} from "./windowState";

export const WORKSPACE_VERSION = 1 as const;
export const LAUNCH_RECIPE_VERSION = 1 as const;

export interface SnapshotLayoutLeafV1 {
  kind: "leaf";
  tabKey: string;
}

export interface SnapshotLayoutSplitV1 {
  kind: "split";
  direction: "col" | "row";
  children: [SnapshotLayoutNodeV1, SnapshotLayoutNodeV1];
  ratio: number;
}

export type SnapshotLayoutNodeV1 = SnapshotLayoutLeafV1 | SnapshotLayoutSplitV1;

export interface WorkspaceTabV1 {
  key: string;
  title: string;
  customTitle?: string;
  projectPath: string;
  projectName?: string;
  launch: LaunchSpecV1;
  pinned?: boolean;
}

export type WorkspaceEntryV1 =
  | { kind: "tab"; tab: WorkspaceTabV1 }
  | {
      kind: "group";
      key: string;
      name: string;
      pinned?: boolean;
      tabs: WorkspaceTabV1[];
      layout: SnapshotLayoutNodeV1;
      activeLeafKey?: string;
    };

export interface WorkspaceV1 {
  version: typeof WORKSPACE_VERSION;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  entries: WorkspaceEntryV1[];
  activeEntryKey?: string;
}

export type RecipeCwdV1 =
  | { kind: "project" }
  | { kind: "home" }
  | { kind: "absolute"; path: string };

export type RecipeLaunchSpecV1 = Exclude<LaunchSpecV1, { kind: "session" }>;

export interface RecipeTabV1 {
  key: string;
  title: string;
  customTitle?: string;
  cwd: RecipeCwdV1;
  projectName?: string;
  launch: RecipeLaunchSpecV1;
  pinned?: boolean;
}

export type RecipeEntryV1 =
  | { kind: "tab"; tab: RecipeTabV1 }
  | {
      kind: "group";
      key: string;
      name: string;
      pinned?: boolean;
      tabs: RecipeTabV1[];
      layout: SnapshotLayoutNodeV1;
      activeLeafKey?: string;
    };

export interface LaunchRecipeV1 {
  version: typeof LAUNCH_RECIPE_VERSION;
  id: string;
  name: string;
  description?: string;
  projectPath?: string;
  createdAt: number;
  updatedAt: number;
  entries: RecipeEntryV1[];
  activeEntryKey?: string;
}

export interface LaunchAvailability {
  installedAgents?: ReadonlySet<WindowAgentId>;
  availableShellIds?: ReadonlySet<string>;
  pathExists?: (path: string) => boolean;
}

export interface RecipePreflightContext extends LaunchAvailability {
  projectPath?: string;
}

export type PlanResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

export interface MaterializedPlan {
  state: WindowStateV1;
  tabIdsByKey: ReadonlyMap<string, string>;
  entryIdsByKey: ReadonlyMap<string, string>;
  skippedEntries: readonly { key: string; reason: "duplicate-session" }[];
}

export interface EffectiveWorkspace {
  workspace: WorkspaceV1;
  skippedEntries: readonly { key: string; reason: "duplicate-session" }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function addIssue(issues: ValidationIssue[], code: string, path: string, message: string) {
  issues.push({ code, path, message });
}

function cloneLaunch(launch: LaunchSpecV1): LaunchSpecV1 {
  if (launch.kind !== "command") return { ...launch };
  return {
    ...launch,
    command: launch.command.kind === "argv" ? { ...launch.command, args: [...launch.command.args] } : { ...launch.command },
    ...(launch.env ? { env: { ...launch.env } } : {}),
  };
}

export function collectSnapshotLayoutTabKeys(node: SnapshotLayoutNodeV1): string[] {
  return node.kind === "leaf"
    ? [node.tabKey]
    : [...collectSnapshotLayoutTabKeys(node.children[0]), ...collectSnapshotLayoutTabKeys(node.children[1])];
}

export function mapSnapshotLayoutTabKeys(node: SnapshotLayoutNodeV1, ids: ReadonlyMap<string, string>): WindowLayoutNodeV1 {
  if (node.kind === "leaf") return { kind: "leaf", tabId: ids.get(node.tabKey) ?? node.tabKey };
  return {
    kind: "split",
    direction: node.direction,
    ratio: node.ratio,
    children: [mapSnapshotLayoutTabKeys(node.children[0], ids), mapSnapshotLayoutTabKeys(node.children[1], ids)],
  };
}

function windowLayoutToSnapshot(node: WindowLayoutNodeV1, keys: ReadonlyMap<string, string>): SnapshotLayoutNodeV1 {
  if (node.kind === "leaf") return { kind: "leaf", tabKey: keys.get(node.tabId) ?? node.tabId };
  return {
    kind: "split",
    direction: node.direction,
    ratio: node.ratio,
    children: [windowLayoutToSnapshot(node.children[0], keys), windowLayoutToSnapshot(node.children[1], keys)],
  };
}

function validateSnapshotLayout(value: unknown, path: string, issues: ValidationIssue[], leaves: string[]): value is SnapshotLayoutNodeV1 {
  if (!isRecord(value)) { addIssue(issues, "invalid_layout", path, "Layout node must be an object."); return false; }
  if (value.kind === "leaf") {
    if (!nonEmpty(value.tabKey)) addIssue(issues, "invalid_layout_leaf", `${path}.tabKey`, "Layout leaf requires a tab key.");
    else leaves.push(value.tabKey);
    return true;
  }
  if (value.kind === "split") {
    if (value.direction !== "col" && value.direction !== "row") addIssue(issues, "invalid_split_direction", `${path}.direction`, "Split direction must be col or row.");
    if (typeof value.ratio !== "number" || !Number.isFinite(value.ratio) || value.ratio <= 0 || value.ratio >= 1) {
      addIssue(issues, "invalid_split_ratio", `${path}.ratio`, "Split ratio must be between zero and one.");
    }
    if (!Array.isArray(value.children) || value.children.length !== 2) {
      addIssue(issues, "invalid_split_children", `${path}.children`, "A split requires exactly two children.");
      return false;
    }
    validateSnapshotLayout(value.children[0], `${path}.children[0]`, issues, leaves);
    validateSnapshotLayout(value.children[1], `${path}.children[1]`, issues, leaves);
    return true;
  }
  addIssue(issues, "invalid_layout_kind", `${path}.kind`, "Layout kind must be leaf or split.");
  return false;
}

interface PlanTabLike {
  key?: unknown;
  title?: unknown;
  customTitle?: unknown;
  projectPath?: unknown;
  projectName?: unknown;
  launch?: unknown;
  pinned?: unknown;
}

function validatePlanTab(raw: unknown, path: string, issues: ValidationIssue[], allowSession: boolean): raw is WorkspaceTabV1 {
  if (!isRecord(raw)) { addIssue(issues, "invalid_tab", path, "Plan tab must be an object."); return false; }
  const tab = raw as PlanTabLike;
  if (!nonEmpty(tab.key)) addIssue(issues, "invalid_tab_key", `${path}.key`, "Tab key is required.");
  if (!nonEmpty(tab.title)) addIssue(issues, "invalid_title", `${path}.title`, "Tab title is required.");
  if (tab.customTitle !== undefined && !nonEmpty(tab.customTitle)) addIssue(issues, "invalid_custom_title", `${path}.customTitle`, "Custom title cannot be empty.");
  if (tab.projectPath !== undefined && typeof tab.projectPath !== "string") addIssue(issues, "invalid_project_path", `${path}.projectPath`, "Project path must be a string.");
  if (tab.projectName !== undefined && typeof tab.projectName !== "string") addIssue(issues, "invalid_project_name", `${path}.projectName`, "Project name must be a string.");
  if (tab.pinned !== undefined && typeof tab.pinned !== "boolean") addIssue(issues, "invalid_pinned", `${path}.pinned`, "Pinned must be boolean.");
  if (validateLaunchSpec(tab.launch, `${path}.launch`, issues) && !allowSession && (tab.launch as LaunchSpecV1).kind === "session") {
    addIssue(issues, "recipe_session", `${path}.launch`, "Launch recipes start fresh processes and cannot resume a session.");
  }
  return true;
}

function validateEntries(entries: unknown, path: string, issues: ValidationIssue[], allowSession: boolean, recipeCwd: boolean): Set<string> {
  const entryKeys = new Set<string>();
  const tabKeys = new Set<string>();
  if (!Array.isArray(entries)) { addIssue(issues, "invalid_entries", path, "Entries must be an array."); return entryKeys; }
  if (entries.length === 0) addIssue(issues, "empty_plan", path, "At least one entry is required.");
  entries.forEach((raw, entryIndex) => {
    const entryPath = `${path}[${entryIndex}]`;
    if (!isRecord(raw) || (raw.kind !== "tab" && raw.kind !== "group")) { addIssue(issues, "invalid_entry", entryPath, "Entry must be a tab or group."); return; }
    if (raw.kind === "tab") {
      validatePlanTab(raw.tab, `${entryPath}.tab`, issues, allowSession);
      if (isRecord(raw.tab) && nonEmpty(raw.tab.key)) {
        if (entryKeys.has(raw.tab.key) || tabKeys.has(raw.tab.key)) addIssue(issues, "duplicate_key", `${entryPath}.tab.key`, `Duplicate key ${raw.tab.key}.`);
        entryKeys.add(raw.tab.key);
        tabKeys.add(raw.tab.key);
      }
      if (recipeCwd && isRecord(raw.tab)) validateRecipeCwd(raw.tab.cwd, `${entryPath}.tab.cwd`, issues);
      return;
    }
    if (!nonEmpty(raw.key)) addIssue(issues, "invalid_group_key", `${entryPath}.key`, "Group key is required.");
    else {
      if (entryKeys.has(raw.key) || tabKeys.has(raw.key)) addIssue(issues, "duplicate_key", `${entryPath}.key`, `Duplicate key ${raw.key}.`);
      entryKeys.add(raw.key);
    }
    if (!nonEmpty(raw.name)) addIssue(issues, "invalid_group_name", `${entryPath}.name`, "Group name is required.");
    if (raw.pinned !== undefined && typeof raw.pinned !== "boolean") addIssue(issues, "invalid_pinned", `${entryPath}.pinned`, "Pinned must be boolean.");
    if (!Array.isArray(raw.tabs)) { addIssue(issues, "invalid_group_tabs", `${entryPath}.tabs`, "Group tabs must be an array."); return; }
    const localKeys = new Set<string>();
    raw.tabs.forEach((tab, tabIndex) => {
      const tabPath = `${entryPath}.tabs[${tabIndex}]`;
      validatePlanTab(tab, tabPath, issues, allowSession);
      if (isRecord(tab) && nonEmpty(tab.key)) {
        if (tabKeys.has(tab.key) || localKeys.has(tab.key) || entryKeys.has(tab.key)) addIssue(issues, "duplicate_key", `${tabPath}.key`, `Duplicate key ${tab.key}.`);
        tabKeys.add(tab.key);
        localKeys.add(tab.key);
      }
      if (isRecord(tab) && tab.pinned) addIssue(issues, "pinned_group_member", `${tabPath}.pinned`, "Pin the group entry, not an individual pane.");
      if (recipeCwd && isRecord(tab)) validateRecipeCwd(tab.cwd, `${tabPath}.cwd`, issues);
    });
    const leaves: string[] = [];
    validateSnapshotLayout(raw.layout, `${entryPath}.layout`, issues, leaves);
    const leafSet = new Set(leaves);
    if (leaves.length < 2 || leaves.length > MAX_GROUP_TABS) addIssue(issues, "invalid_group_size", `${entryPath}.layout`, `Groups require 2-${MAX_GROUP_TABS} tabs.`);
    if (leafSet.size !== leaves.length) addIssue(issues, "duplicate_layout_leaf", `${entryPath}.layout`, "A pane may appear only once in a layout.");
    if (leafSet.size !== localKeys.size || [...localKeys].some(key => !leafSet.has(key))) addIssue(issues, "group_membership_mismatch", entryPath, "Group tabs and layout leaves differ.");
    if (raw.activeLeafKey !== undefined && (!nonEmpty(raw.activeLeafKey) || !leafSet.has(raw.activeLeafKey))) addIssue(issues, "invalid_active_leaf", `${entryPath}.activeLeafKey`, "Active leaf must belong to the group.");
  });
  return entryKeys;
}

function validateRecipeCwd(value: unknown, path: string, issues: ValidationIssue[]) {
  if (!isRecord(value) || (value.kind !== "project" && value.kind !== "home" && value.kind !== "absolute")) {
    addIssue(issues, "invalid_cwd", path, "cwd must be project, home, or absolute.");
    return;
  }
  if (value.kind === "absolute" && (!nonEmpty(value.path) || !isAbsoluteRecipePath(value.path))) {
    addIssue(issues, "invalid_cwd_path", `${path}.path`, "An absolute Windows, UNC, or POSIX cwd path is required.");
  }
}

export function isAbsoluteRecipePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value);
}

function validateSessionUniqueness(entries: unknown[], issues: ValidationIssue[]) {
  const seen = new Map<string, string>();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const tabs = entry.kind === "tab"
      ? [entry.tab]
      : entry.kind === "group" && Array.isArray(entry.tabs)
        ? entry.tabs
        : [];
    for (const tab of tabs) {
      if (!isRecord(tab) || !nonEmpty(tab.key) || !isRecord(tab.launch)) continue;
      if (tab.launch.kind !== "session" || !nonEmpty(tab.launch.agent) || !nonEmpty(tab.launch.sessionId)) continue;
      const key = sessionLaunchKey(tab.launch as unknown as LaunchSpecV1);
      if (!key) continue;
      const existing = seen.get(key);
      if (existing) addIssue(issues, "duplicate_session", "$.entries", `Session ${key} is used by both ${existing} and ${tab.key}.`);
      else seen.set(key, tab.key);
    }
  }
}

export function validateWorkspace(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) return [{ code: "invalid_workspace", path: "$", message: "Workspace must be an object." }];
  if (value.version !== WORKSPACE_VERSION) addIssue(issues, "unsupported_version", "$.version", `Expected workspace version ${WORKSPACE_VERSION}.`);
  if (!nonEmpty(value.id)) addIssue(issues, "invalid_id", "$.id", "Workspace id is required.");
  if (!nonEmpty(value.name)) addIssue(issues, "invalid_name", "$.name", "Workspace name is required.");
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) addIssue(issues, "invalid_created_at", "$.createdAt", "createdAt must be a timestamp.");
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) addIssue(issues, "invalid_updated_at", "$.updatedAt", "updatedAt must be a timestamp.");
  const entryKeys = validateEntries(value.entries, "$.entries", issues, true, false);
  if (value.activeEntryKey !== undefined && (!nonEmpty(value.activeEntryKey) || !entryKeys.has(value.activeEntryKey))) addIssue(issues, "invalid_active_entry", "$.activeEntryKey", "Active entry must exist in the workspace.");
  if (Array.isArray(value.entries)) validateSessionUniqueness(value.entries, issues);
  return issues;
}

export function validateLaunchRecipe(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) return [{ code: "invalid_recipe", path: "$", message: "Launch recipe must be an object." }];
  if (value.version !== LAUNCH_RECIPE_VERSION) addIssue(issues, "unsupported_version", "$.version", `Expected recipe version ${LAUNCH_RECIPE_VERSION}.`);
  if (!nonEmpty(value.id)) addIssue(issues, "invalid_id", "$.id", "Recipe id is required.");
  if (!nonEmpty(value.name)) addIssue(issues, "invalid_name", "$.name", "Recipe name is required.");
  if (value.description !== undefined && typeof value.description !== "string") addIssue(issues, "invalid_description", "$.description", "Description must be a string.");
  if (value.projectPath !== undefined && !nonEmpty(value.projectPath)) addIssue(issues, "invalid_project_path", "$.projectPath", "Project path cannot be empty.");
  if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) addIssue(issues, "invalid_created_at", "$.createdAt", "createdAt must be a timestamp.");
  if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) addIssue(issues, "invalid_updated_at", "$.updatedAt", "updatedAt must be a timestamp.");
  const entryKeys = validateEntries(value.entries, "$.entries", issues, false, true);
  if (value.activeEntryKey !== undefined && (!nonEmpty(value.activeEntryKey) || !entryKeys.has(value.activeEntryKey))) addIssue(issues, "invalid_active_entry", "$.activeEntryKey", "Active entry must exist in the recipe.");
  return issues;
}

function decodeVersioned<T extends { version: 1; createdAt: number; updatedAt: number }>(
  value: unknown,
  validate: (candidate: unknown) => ValidationIssue[],
  now: number,
): DecodeResult<T> {
  if (!isRecord(value)) return { ok: false, issues: validate(value) };
  if (value.version !== undefined && value.version !== 1) return { ok: false, issues: validate(value) };
  const migrated = value.version === undefined;
  const candidate = migrated
    ? { ...value, version: 1, createdAt: typeof value.createdAt === "number" ? value.createdAt : now, updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : now }
    : value;
  const issues = validate(candidate);
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: candidate as T, migrated, warnings: migrated ? ["Migrated an unversioned launch plan to version 1."] : [] };
}

export function decodeWorkspace(value: unknown, now = Date.now()): DecodeResult<WorkspaceV1> {
  return decodeVersioned<WorkspaceV1>(value, validateWorkspace, now);
}

export function decodeLaunchRecipe(value: unknown, now = Date.now()): DecodeResult<LaunchRecipeV1> {
  return decodeVersioned<LaunchRecipeV1>(value, validateLaunchRecipe, now);
}

function workspaceTabFromWindow(tab: WindowTabV1, key: string, pinned?: boolean): WorkspaceTabV1 {
  return {
    key,
    title: tab.title,
    ...(tab.customTitle ? { customTitle: tab.customTitle } : {}),
    projectPath: tab.projectPath,
    ...(tab.projectName !== undefined ? { projectName: tab.projectName } : {}),
    launch: cloneLaunch(tab.launch),
    ...(pinned ? { pinned: true } : {}),
  };
}

export function captureWorkspace(
  state: WindowStateV1,
  metadata: { id: string; name: string; now?: number },
): PlanResult<WorkspaceV1> {
  const stateIssues = validateWindowState(state);
  if (stateIssues.length > 0) return { ok: false, issues: stateIssues };
  const now = metadata.now ?? Date.now();
  const tabById = new Map(state.tabs.map(tab => [tab.id, tab]));
  const groupById = new Map(state.groups.map(group => [group.id, group]));
  const runtimeToKey = new Map<string, string>();
  const entryRuntimeToKey = new Map<string, string>();
  let tabNumber = 0;
  let groupNumber = 0;
  const entries: WorkspaceEntryV1[] = [];
  for (const entry of state.entryOrder) {
    if (entry.kind === "tab") {
      const tab = tabById.get(entry.id)!;
      const key = `tab-${++tabNumber}`;
      runtimeToKey.set(tab.id, key);
      entryRuntimeToKey.set(tab.id, key);
      entries.push({ kind: "tab", tab: workspaceTabFromWindow(tab, key, tab.pinned) });
      continue;
    }
    const group = groupById.get(entry.id)!;
    const key = `group-${++groupNumber}`;
    entryRuntimeToKey.set(group.id, key);
    const memberIds = collectWindowLayoutTabIds(group.layout);
    for (const id of memberIds) runtimeToKey.set(id, `tab-${++tabNumber}`);
    entries.push({
      kind: "group",
      key,
      name: group.name,
      ...(group.pinned ? { pinned: true } : {}),
      tabs: memberIds.map(id => workspaceTabFromWindow(tabById.get(id)!, runtimeToKey.get(id)!)),
      layout: windowLayoutToSnapshot(group.layout, runtimeToKey),
      ...(state.activeLeafByGroup[group.id] ? { activeLeafKey: runtimeToKey.get(state.activeLeafByGroup[group.id]) } : {}),
    });
  }
  const activeEntryKey = state.activeEntryId === "home" || state.activeEntryId === "settings" ? undefined : entryRuntimeToKey.get(state.activeEntryId);
  const workspace: WorkspaceV1 = {
    version: WORKSPACE_VERSION,
    id: metadata.id,
    name: metadata.name,
    createdAt: now,
    updatedAt: now,
    entries,
    ...(activeEntryKey ? { activeEntryKey } : {}),
  };
  const issues = validateWorkspace(workspace);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: workspace };
}

function launchAvailabilityIssues(tab: WorkspaceTabV1, path: string, availability: LaunchAvailability): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const launch = tab.launch;
  if ((launch.kind === "session" || launch.kind === "agent") && availability.installedAgents && !availability.installedAgents.has(launch.agent)) {
    addIssue(issues, "missing_agent", `${path}.launch.agent`, `Agent ${launch.agent} is not installed.`);
  }
  const shellId = launch.kind === "shell" || launch.kind === "command" ? launch.shellId : launch.hostShellId;
  if (shellId && availability.availableShellIds && !availability.availableShellIds.has(shellId)) {
    addIssue(issues, "missing_shell", `${path}.launch`, `Shell ${shellId} is not available.`);
  }
  if (tab.projectPath && availability.pathExists && !availability.pathExists(tab.projectPath)) {
    addIssue(issues, "missing_cwd", `${path}.projectPath`, `Working directory does not exist: ${tab.projectPath}`);
  }
  return issues;
}

export function preflightWorkspace(workspace: WorkspaceV1, state: WindowStateV1, mode: "merge" | "replace", availability: LaunchAvailability = {}): ValidationIssue[] {
  const issues = [...validateWorkspace(workspace), ...validateWindowState(state)];
  if (issues.length > 0) return issues;
  const retained = mode === "merge" ? state : retainPinnedEntries(state);
  const sessions = new Set(retained.tabs.map(tab => sessionLaunchKey(tab.launch)).filter(nonEmpty));
  const effective = effectiveWorkspaceForPreflight(workspace, state, mode).workspace;
  effective.entries.forEach((entry, entryIndex) => {
    const tabs = entry.kind === "tab" ? [entry.tab] : entry.tabs;
    tabs.forEach((tab, tabIndex) => {
      const path = entry.kind === "tab" ? `$.entries[${entryIndex}].tab` : `$.entries[${entryIndex}].tabs[${tabIndex}]`;
      issues.push(...launchAvailabilityIssues(tab, path, availability));
      const key = sessionLaunchKey(tab.launch);
      if (key && sessions.has(key) && mode === "replace") addIssue(issues, "duplicate_session", `${path}.launch.sessionId`, `Session ${key} conflicts with a retained pinned entry.`);
      if (key) sessions.add(key);
    });
  });
  return issues;
}

/** Removes merge entries that cannot be opened because their session already exists. */
export function effectiveWorkspaceForPreflight(
  workspace: WorkspaceV1,
  current: WindowStateV1,
  mode: "merge" | "replace",
): EffectiveWorkspace {
  if (mode !== "merge") return { workspace, skippedEntries: [] };
  const existingSessions = new Set(
    current.tabs.map(tab => sessionLaunchKey(tab.launch)).filter(nonEmpty),
  );
  const skippedEntries: { key: string; reason: "duplicate-session" }[] = [];
  const entries = workspace.entries.filter(entry => {
    const entryKey = entry.kind === "tab" ? entry.tab.key : entry.key;
    const sessions = (entry.kind === "tab" ? [entry.tab] : entry.tabs)
      .map(tab => sessionLaunchKey(tab.launch))
      .filter(nonEmpty);
    if (sessions.some(session => existingSessions.has(session))) {
      skippedEntries.push({ key: entryKey, reason: "duplicate-session" });
      return false;
    }
    for (const session of sessions) existingSessions.add(session);
    return true;
  });
  return { workspace: { ...workspace, entries }, skippedEntries };
}

function retainPinnedEntries(state: WindowStateV1): WindowStateV1 {
  const pinnedEntries = state.entryOrder.filter(entry => entry.kind === "group"
    ? state.groups.some(group => group.id === entry.id && group.pinned)
    : state.tabs.some(tab => tab.id === entry.id && tab.pinned));
  const pinnedIds = new Set(pinnedEntries.map(entry => entry.id));
  const groups = state.groups.filter(group => pinnedIds.has(group.id));
  const groupTabIds = new Set(groups.flatMap(group => collectWindowLayoutTabIds(group.layout)));
  const tabs = state.tabs.filter(tab => groupTabIds.has(tab.id) || (!tab.groupId && pinnedIds.has(tab.id)));
  const activeLeafByGroup: Record<string, string> = {};
  for (const group of groups) {
    const active = state.activeLeafByGroup[group.id];
    if (active) activeLeafByGroup[group.id] = active;
  }
  return {
    ...state,
    tabs,
    groups,
    entryOrder: pinnedEntries,
    activeEntryId: pinnedIds.has(state.activeEntryId) ? state.activeEntryId : "home",
    activeLeafByGroup,
  };
}

function allocate(scope: "tab" | "group", used: Set<string>, factory: IdFactory): string | null {
  for (let attempt = 0; attempt < 100; attempt++) {
    const id = factory(scope);
    if (nonEmpty(id) && !used.has(id)) { used.add(id); return id; }
  }
  return null;
}

export function materializeWorkspace(
  workspace: WorkspaceV1,
  current: WindowStateV1,
  options: { mode: "merge" | "replace"; availability?: LaunchAvailability; idFactory?: IdFactory },
): PlanResult<MaterializedPlan> {
  const issues = preflightWorkspace(workspace, current, options.mode, options.availability);
  if (issues.length > 0) return { ok: false, issues };
  const base = options.mode === "merge" ? current : retainPinnedEntries(current);
  const factory = options.idFactory ?? defaultIdFactory;
  const used = new Set([...base.tabs.map(tab => tab.id), ...base.groups.map(group => group.id)]);
  const tabIdsByKey = new Map<string, string>();
  const entryIdsByKey = new Map<string, string>();
  const effective = effectiveWorkspaceForPreflight(workspace, current, options.mode);
  const skippedEntries = [...effective.skippedEntries];
  const entries = effective.workspace.entries;

  for (const entry of entries) {
    const tabs = entry.kind === "tab" ? [entry.tab] : entry.tabs;
    for (const tab of tabs) {
      const id = allocate("tab", used, factory);
      if (!id) return { ok: false, issues: [{ code: "id_exhausted", path: "$.entries", message: "Could not allocate fresh tab ids." }] };
      tabIdsByKey.set(tab.key, id);
    }
    const entryKey = entry.kind === "tab" ? entry.tab.key : entry.key;
    if (entry.kind === "tab") entryIdsByKey.set(entryKey, tabIdsByKey.get(entry.tab.key)!);
    else {
      const id = allocate("group", used, factory);
      if (!id) return { ok: false, issues: [{ code: "id_exhausted", path: "$.entries", message: "Could not allocate fresh group ids." }] };
      entryIdsByKey.set(entryKey, id);
    }
  }

  const tabs: WindowTabV1[] = [];
  const groups: WindowGroupV1[] = [];
  const entryOrder: WindowEntryRefV1[] = [];
  const activeLeafByGroup: Record<string, string> = { ...base.activeLeafByGroup };
  for (const entry of entries) {
    if (entry.kind === "tab") {
      const id = tabIdsByKey.get(entry.tab.key)!;
      tabs.push({
        id,
        title: entry.tab.title,
        ...(entry.tab.customTitle ? { customTitle: entry.tab.customTitle } : {}),
        projectPath: entry.tab.projectPath,
        ...(entry.tab.projectName !== undefined ? { projectName: entry.tab.projectName } : {}),
        launch: cloneLaunch(entry.tab.launch),
        ...(entry.tab.pinned ? { pinned: true } : {}),
      });
      entryOrder.push({ kind: "tab", id });
      continue;
    }
    const groupId = entryIdsByKey.get(entry.key)!;
    for (const tab of entry.tabs) {
      tabs.push({
        id: tabIdsByKey.get(tab.key)!,
        title: tab.title,
        ...(tab.customTitle ? { customTitle: tab.customTitle } : {}),
        projectPath: tab.projectPath,
        ...(tab.projectName !== undefined ? { projectName: tab.projectName } : {}),
        launch: cloneLaunch(tab.launch),
        groupId,
      });
    }
    const group: WindowGroupV1 = {
      id: groupId,
      name: entry.name,
      layout: mapSnapshotLayoutTabKeys(entry.layout, tabIdsByKey),
      ...(entry.pinned ? { pinned: true } : {}),
    };
    groups.push(group);
    entryOrder.push({ kind: "group", id: groupId });
    const activeLeaf = entry.activeLeafKey ? tabIdsByKey.get(entry.activeLeafKey) : collectWindowLayoutTabIds(group.layout)[0];
    if (activeLeaf) activeLeafByGroup[groupId] = activeLeaf;
  }
  const requestedActive = workspace.activeEntryKey ? entryIdsByKey.get(workspace.activeEntryKey) : undefined;
  const firstNewEntry = entryOrder[0]?.id;
  const state: WindowStateV1 = {
    version: WINDOW_STATE_VERSION,
    tabs: [...base.tabs, ...tabs],
    groups: [...base.groups, ...groups],
    entryOrder: [...base.entryOrder, ...entryOrder],
    activeEntryId: requestedActive ?? firstNewEntry ?? base.activeEntryId,
    activeLeafByGroup,
  };
  const stateIssues = validateWindowState(state);
  return stateIssues.length > 0 ? { ok: false, issues: stateIssues } : { ok: true, value: { state, tabIdsByKey, entryIdsByKey, skippedEntries } };
}

function resolveRecipeCwd(cwd: RecipeCwdV1, recipe: LaunchRecipeV1, context: RecipePreflightContext): string | null {
  if (cwd.kind === "home") return "";
  if (cwd.kind === "absolute") return cwd.path;
  return context.projectPath ?? recipe.projectPath ?? null;
}

export function preflightLaunchRecipe(recipe: LaunchRecipeV1, context: RecipePreflightContext): PlanResult<WorkspaceV1> {
  const issues = validateLaunchRecipe(recipe);
  if (issues.length > 0) return { ok: false, issues };
  const entries: WorkspaceEntryV1[] = [];
  recipe.entries.forEach((entry, entryIndex) => {
    const convert = (tab: RecipeTabV1, tabIndex: number): WorkspaceTabV1 | null => {
      const path = entry.kind === "tab" ? `$.entries[${entryIndex}].tab` : `$.entries[${entryIndex}].tabs[${tabIndex}]`;
      const projectPath = resolveRecipeCwd(tab.cwd, recipe, context);
      if (projectPath === null) addIssue(issues, "missing_project", `${path}.cwd`, "A project cwd was requested but no project is in context.");
      const candidate: WorkspaceTabV1 = {
        key: tab.key,
        title: tab.title,
        ...(tab.customTitle ? { customTitle: tab.customTitle } : {}),
        projectPath: projectPath ?? "",
        ...(tab.projectName !== undefined ? { projectName: tab.projectName } : {}),
        launch: cloneLaunch(tab.launch),
        ...(tab.pinned ? { pinned: true } : {}),
      };
      issues.push(...launchAvailabilityIssues(candidate, path, context));
      return projectPath === null ? null : candidate;
    };
    if (entry.kind === "tab") {
      const tab = convert(entry.tab, 0);
      if (tab) entries.push({ kind: "tab", tab });
    } else {
      const tabs = entry.tabs.map(convert).filter((tab): tab is WorkspaceTabV1 => tab !== null);
      entries.push({
        kind: "group",
        key: entry.key,
        name: entry.name,
        ...(entry.pinned ? { pinned: true } : {}),
        tabs,
        layout: entry.layout,
        ...(entry.activeLeafKey ? { activeLeafKey: entry.activeLeafKey } : {}),
      });
    }
  });
  if (issues.length > 0) return { ok: false, issues };
  const workspace: WorkspaceV1 = {
    version: WORKSPACE_VERSION,
    id: `recipe:${recipe.id}`,
    name: recipe.name,
    createdAt: recipe.createdAt,
    updatedAt: recipe.updatedAt,
    entries,
    ...(recipe.activeEntryKey ? { activeEntryKey: recipe.activeEntryKey } : {}),
  };
  const workspaceIssues = validateWorkspace(workspace);
  return workspaceIssues.length > 0 ? { ok: false, issues: workspaceIssues } : { ok: true, value: workspace };
}

export function materializeLaunchRecipe(
  recipe: LaunchRecipeV1,
  current: WindowStateV1,
  options: { context: RecipePreflightContext; idFactory?: IdFactory },
): PlanResult<MaterializedPlan> {
  const preflight = preflightLaunchRecipe(recipe, options.context);
  if (!preflight.ok) return preflight;
  return materializeWorkspace(preflight.value, current, {
    mode: "merge",
    availability: options.context,
    idFactory: options.idFactory,
  });
}

export function workspaceGroupLayoutWithRuntimeIds(entry: Extract<WorkspaceEntryV1, { kind: "group" }>, tabIdsByKey: ReadonlyMap<string, string>): WindowLayoutNodeV1 {
  return mapSnapshotLayoutTabKeys(entry.layout, tabIdsByKey);
}

export function cloneRuntimeLayoutForSnapshot(node: WindowLayoutNodeV1): WindowLayoutNodeV1 {
  return cloneWindowLayout(node);
}

export function remapRuntimeLayout(node: WindowLayoutNodeV1, ids: ReadonlyMap<string, string>): WindowLayoutNodeV1 {
  return mapWindowLayoutTabIds(node, ids);
}
