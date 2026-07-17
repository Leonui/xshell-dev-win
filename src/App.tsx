import { useState, useEffect, useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { load } from "@tauri-apps/plugin-store";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { AlertTriangle, X as XIcon } from "lucide-react";
import activityOverlayUrl from "../src-tauri/icons/32x32.png?url";
import { getAvailableShells, getDefaultShellId, getShellById } from "./shells";
import { Sidebar } from "./components/Sidebar";
import { TabBar } from "./components/TabBar";
import { HomeView } from "./components/HomeView";
import { TerminalTab } from "./components/TerminalTab";
import { SettingsView, type ThemeMode } from "./components/SettingsView";
import { DARK_TERM_BG, LIGHT_TERM_BG } from "./components/TerminalTab";
import { ProjectEditorDialog } from "./components/ProjectEditorDialog";
import { ProjectPicker } from "./components/ProjectPicker";
import { AgentPickerDialog } from "./components/AgentPickerDialog";
import { AGENT_IDS, AGENTS, type AgentId } from "./agents";
import type { ProjectInfo, ProjectSettings, SessionFolder, SessionInfo, Tab, Group, LayoutNode, SidebarItem, SidebarFolder } from "./types";
import { GroupView } from "./components/GroupView";
import { countLeaves, collectLeafIds, insertLeaf, setRatioAt, DropZone } from "./layout";
import { useUpdateCheck } from "./hooks/useUpdateCheck";
import { UpdateDialog } from "./components/UpdateDialog";
import {
  getDefaultInteractionSettings,
  findInteractionSettingConflicts,
  sanitizeInteractionSettings,
  type InteractionSettings,
} from "./lib/interactionSettings";
import {
  decodeWindowState,
  closeWindowEntry,
  closeWindowPane,
  migrateLegacyWindowState,
  undoLastClosed,
  validateWindowState,
  type ClosedRecordV1,
  type LaunchSpecV1,
} from "./lib/windowState";
import {
  createWindowState,
  decodeRuntimeWindowState,
  filterStartupWindowState,
  findActiveRuntimeTab,
  preservePendingCommandConfirmations,
  requireConfirmationForNewCommandTabs,
} from "./lib/runtimeWindowState";
import {
  captureWorkspace,
  decodeLaunchRecipe,
  decodeWorkspace,
  effectiveWorkspaceForPreflight,
  materializeLaunchRecipe,
  materializeWorkspace,
  preflightLaunchRecipe,
  preflightWorkspace,
  type LaunchRecipeV1,
  type WorkspaceV1,
} from "./lib/launchPlans";
import {
  DEFAULT_AGENT_NOTIFICATION_PREFERENCES,
  acknowledgeTerminalActivities,
  createTerminalActivity,
  notificationDecision,
  reduceTerminalActivity,
  sanitizeAgentNotificationPreferences,
  type ActivityByTabId,
  type ActivityEvent,
  type AgentNotificationPreferences,
  type HookActivityEvent,
} from "./lib/terminalActivity";

type PolledActivityEvent = HookActivityEvent & { tabId: string };

// Flatten sidebar items to an ordered list of project paths (folders expanded in place).
// Used to derive `savedPaths` for downstream code that doesn't care about folders.
function flattenSidebarPaths(layout: SidebarItem[]): string[] {
  const out: string[] = [];
  for (const item of layout) {
    if (item.kind === "project") out.push(item.path);
    else for (const p of item.projectPaths) out.push(p);
  }
  return out;
}

function removeProjectFromLayout(layout: SidebarItem[], path: string): SidebarItem[] {
  const pl = path.toLowerCase();
  const out: SidebarItem[] = [];
  for (const item of layout) {
    if (item.kind === "project") {
      if (item.path.toLowerCase() !== pl) out.push(item);
    } else {
      const kept = item.projectPaths.filter(p => p.toLowerCase() !== pl);
      if (kept.length > 0) out.push({ ...item, projectPaths: kept });
      // An empty folder is dropped entirely — no ghost folders sticking around.
    }
  }
  return out;
}

function addProjectToLayout(layout: SidebarItem[], path: string): SidebarItem[] {
  if (flattenSidebarPaths(layout).some(p => p.toLowerCase() === path.toLowerCase())) return layout;
  return [...layout, { kind: "project", path }];
}

// Overlay that paints a drop-zone rectangle (edge of a target pane) while a tab is
// being dragged. Computed from the target pane's live bounding rect + the zone.
function DropZoneOverlay({ targetTabId, zone }: { targetTabId: string; zone: "left" | "right" | "top" | "bottom" }) {
  const el = document.querySelector(`[data-group-leaf="${CSS.escape(targetTabId)}"]`) as HTMLElement | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const area = (el.closest(".work-area") as HTMLElement | null)?.getBoundingClientRect();
  if (!area) return null;
  const left = r.left - area.left;
  const top = r.top - area.top;
  const fullW = r.width, fullH = r.height;
  let box: React.CSSProperties = { left, top, width: fullW, height: fullH };
  if (zone === "left")   box = { left,                    top,                    width: fullW * 0.5, height: fullH };
  if (zone === "right")  box = { left: left + fullW * 0.5, top,                    width: fullW * 0.5, height: fullH };
  if (zone === "top")    box = { left,                    top,                    width: fullW,       height: fullH * 0.5 };
  if (zone === "bottom") box = { left,                    top: top + fullH * 0.5,  width: fullW,       height: fullH * 0.5 };
  return <div className="drop-zone-preview" style={box} />;
}

function describePlanIssues(issues: readonly { message: string }[]): string {
  const messages = issues.slice(0, 3).map(issue => issue.message);
  return `${messages.join(" ")}${issues.length > messages.length ? ` (${issues.length - messages.length} more)` : ""}`;
}

function workspaceDirectories(workspace: WorkspaceV1): string[] {
  const seen = new Set<string>();
  for (const entry of workspace.entries) {
    const tabs = entry.kind === "tab" ? [entry.tab] : entry.tabs;
    for (const tab of tabs) {
      if (tab.projectPath.trim()) seen.add(tab.projectPath);
    }
  }
  return [...seen];
}

function workspaceShellIds(workspace: WorkspaceV1, fallbackShellId: string): string[] {
  const seen = new Set<string>();
  for (const entry of workspace.entries) {
    const tabs = entry.kind === "tab" ? [entry.tab] : entry.tabs;
    for (const tab of tabs) {
      const shellId = tab.launch.kind === "shell" || tab.launch.kind === "command"
        ? tab.launch.shellId
        : tab.launch.hostShellId || fallbackShellId;
      if (shellId) seen.add(shellId);
    }
  }
  return [...seen];
}

interface WorkspaceCommandPreflight {
  launch: Extract<LaunchSpecV1, { kind: "command" }>;
  cwd: string;
}

function workspaceCommandPreflights(workspace: WorkspaceV1): WorkspaceCommandPreflight[] {
  const launches: WorkspaceCommandPreflight[] = [];
  for (const entry of workspace.entries) {
    const tabs = entry.kind === "tab" ? [entry.tab] : entry.tabs;
    for (const tab of tabs) {
      if (tab.launch.kind === "command") launches.push({ launch: tab.launch, cwd: tab.projectPath });
    }
  }
  return launches;
}

function workspaceDependencySignature(workspace: WorkspaceV1, fallbackShellId: string): string {
  return JSON.stringify([
    workspaceDirectories(workspace).sort(),
    workspaceShellIds(workspace, fallbackShellId).sort(),
    workspaceCommandPreflights(workspace),
  ]);
}

interface WorkspaceDependencyProbe {
  missingDirectories: string[];
  missingShells: string[];
}

export default function App() {
  const [allProjects, setAllProjects] = useState<ProjectInfo[]>([]);
  const [savedPaths, setSavedPaths] = useState<string[]>([]);
  // Discord-style sidebar — top-level list of projects and folders-of-projects. `savedPaths`
  // is kept as a derived flat view (used by other components that just want "which projects
  // are pinned") but `sidebarLayout` is the source of truth for ordering + grouping.
  const [sidebarLayout, setSidebarLayout] = useState<SidebarItem[]>([]);
  const [projectIcons, setProjectIcons] = useState<Record<string, ProjectSettings>>({});
  const [userProjects, setUserProjects] = useState<ProjectInfo[]>([]);
  const [selectedProject, setSelectedProject] = useState<ProjectInfo | null>(null);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [activeTabId, setActiveTabId] = useState("home");
  const [activeLeafByGroup, setActiveLeafByGroup] = useState<Record<string, string>>({});
  const [interactionSettings, setInteractionSettings] = useState<InteractionSettings>(() => getDefaultInteractionSettings());
  const [restoreUnpinnedTabs, setRestoreUnpinnedTabs] = useState(true);
  const [closedHistory, setClosedHistory] = useState<ClosedRecordV1[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceV1[]>([]);
  const [launchRecipes, setLaunchRecipes] = useState<LaunchRecipeV1[]>([]);
  const [workspaceCaptureOpen, setWorkspaceCaptureOpen] = useState(false);
  const [workspaceCaptureName, setWorkspaceCaptureName] = useState("");
  const [appNotice, setAppNotice] = useState<string | null>(null);
  const [activities, setActivities] = useState<ActivityByTabId>({});
  const [notificationPreferences, setNotificationPreferences] = useState<AgentNotificationPreferences>(DEFAULT_AGENT_NOTIFICATION_PREFERENCES);
  const [nativeNotificationPermission, setNativeNotificationPermission] = useState(false);
  const [notificationsReady, setNotificationsReady] = useState(false);
  const [isWindowFocused, setIsWindowFocused] = useState(true);
  const [tabsRestored, setTabsRestored] = useState(false);
  const groupCounterRef = useRef(1);
  const [recentSessions, setRecentSessions] = useState<SessionInfo[]>([]);
  const [projectSessions, setProjectSessions] = useState<SessionInfo[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  // Lazy polling = only fetch git status while the panel is open (a single fetch fires at
  // session start so the activity-bar icon has something to show). Eager polling re-fetches
  // every 3s while the tab is active. Default lazy: most users only need fresh git data
  // when they're actually looking at it.
  const [gitLazyPolling, setGitLazyPolling] = useState(true);
  // Show git changes as a folder tree (default). Off = flat list with a dimmed path per file.
  const [gitChangesTree, setGitChangesTree] = useState(true);
  // When on (default), a newly opened agent terminal shows the file-explorer panel immediately.
  const [fileExplorerOnStart, setFileExplorerOnStart] = useState(true);
  const [contextTreeEnabled, setContextTreeEnabled] = useState(true);
  // Both default to true: setting up the statusline hook is the meaningful gesture, the
  // toggles let the user hide either feature even with stats available.
  const [showRateLimitInSidebar, setShowRateLimitInSidebar] = useState(true);
  // Codex's twin of rate_limit_in_sidebar. Independent because the data source differs:
  // Claude's limits need the statusline hook, Codex's come straight from its rollout files
  // (so this toggle has no hook gate). The sidebar chip shows whichever agents are enabled
  // and have data; both share one popover.
  const [showRateLimitInSidebarCodex, setShowRateLimitInSidebarCodex] = useState(true);
  const [showSessionRowMetrics, setShowSessionRowMetrics] = useState(true);
  // Codex's twin of session_row_metrics — independent because the data sources differ:
  // Claude row metrics need the statusline hook, Codex reads its rollout files directly.
  const [showSessionRowMetricsCodex, setShowSessionRowMetricsCodex] = useState(true);
  // opencode's twin — its metrics come straight from opencode.db, no hook needed.
  const [showSessionRowMetricsOpencode, setShowSessionRowMetricsOpencode] = useState(true);
  // Replaces the project path in the Claude terminal header with a cost/context strip.
  // Only takes effect when the statusline hook has populated authoritative stats for the
  // session — without it there'd be nothing to show, so the header keeps the path.
  const [showTerminalHeaderStats, setShowTerminalHeaderStats] = useState(true);
  // Daily-cost chart + totals panel above the session list on the project page. Same
  // dependency on the statusline hook — the chart series comes from xshell-stats data.
  const [showProjectStatsChart, setShowProjectStatsChart] = useState(true);
  const [terminalBgColor, setTerminalBgColor] = useState("#1c1c1b");
  const [defaultTerminalFontSize, setDefaultTerminalFontSize] = useState(14);
  const [alwaysOnTop, setAlwaysOnTop] = useState(false);
  // Sets CLAUDE_CODE_NO_FLICKER=1 on every claude session so it uses the alternate-screen
  // buffer renderer. Default ON — flicker-free is what most users want; only flip if the
  // user wants scrollback-style output (or hits a renderer bug).
  const [fullscreenRendering, setFullscreenRendering] = useState(true);
  // Sets CLAUDE_CODE_FORCE_SYNC_OUTPUT=1 so claude wraps each TUI frame in DEC 2026
  // synchronized-output markers. xterm.js v5+ honors them and renders only complete
  // frames — fixes the "flying letters" residue where xterm would otherwise see
  // half-drawn intermediate frames. Default ON — strongly recommended.
  const [forceSyncOutput, setForceSyncOutput] = useState(true);
  // Use xterm.js's GPU-accelerated WebGL renderer. Default ON — it eliminates the subpixel
  // seams that show up in Claude Code's startup banner (half-block Unicode chars on the
  // DOM renderer pick up a faint horizontal line between the upper and lower halves) and
  // is generally smoother. Falls back to the DOM renderer if the host's GPU can't give us
  // a WebGL context.
  const [webglRendering, setWebglRendering] = useState(true);
  // CSS font weight applied to terminal text. 300 matches the original hardcoded value;
  // 400 reads heavier and helps compensate for the WebGL renderer's grayscale-only AA.
  const [terminalFontWeight, setTerminalFontWeight] = useState(400);
  // Spawn each restored tab's PTY on app launch instead of deferring until the user clicks the
  // tab. Default OFF — eager-init spawns every restored agent at once on launch (heavy, and
  // burns rate limits on sessions you may not open). Opt in via Settings; a persisted choice
  // overrides this default. The "Starting…" overlay covers the per-tab boot when deferred.
  const [eagerInitTabs, setEagerInitTabs] = useState(false);
  const [defaultShell, setDefaultShell] = useState<string>(getDefaultShellId());
  // Cost vs Tokens for the per-project stats panel. Global, not per-project — reflects what
  // the user cares about generally, not a trait of any one project.
  const [projectStatsView, setProjectStatsView] = useState<'cost' | 'tokens'>('cost');
  const [theme, setTheme] = useState<ThemeMode>("dark");
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [editingProjectPath, setEditingProjectPath] = useState<string | null>(null);
  // Which agent CLIs exist on this machine — gates every agent-choice surface (plus
  // button, dropdown group, default-agent setting). Until the probe lands we assume
  // Claude-only, which matches the app's pre-Codex behavior.
  const [installedAgents, setInstalledAgents] = useState<Record<AgentId, boolean>>(() => Object.fromEntries(AGENT_IDS.map(id => [id, id === "claude"])) as Record<AgentId, boolean>);
  // "ask" = show the agent picker dialog per new chat (only relevant with 2+ agents).
  const [defaultAgent, setDefaultAgent] = useState<"ask" | AgentId>("ask");
  // Project waiting on an agent choice — set when a new chat needs the picker dialog.
  const [agentPickerProject, setAgentPickerProject] = useState<ProjectInfo | null>(null);

  useEffect(() => {
    AGENT_IDS.forEach(id => {
      invoke<{ installed: boolean }>("detect_agent_binary", { binary: AGENTS[id].binary })
        .then(p => setInstalledAgents(prev => ({ ...prev, [id]: p.installed })))
        .catch(() => {});
    });
  }, []);
  // Update check — fetches GitHub Releases on mount; the result drives the red badge on the
  // Settings cog (Sidebar), the About page (SettingsView), and the on-start dialog.
  const updateInfo = useUpdateCheck();
  // One-time-per-version dialog — opens once per launch when GitHub has a newer release AND
  // the user hasn't already skipped that specific version. `lastSeenUpdateVersion` is loaded
  // from the store and re-written on "Skip this version".
  const [lastSeenUpdateVersion, setLastSeenUpdateVersion] = useState<string | null>(null);
  const [lastSeenLoaded, setLastSeenLoaded] = useState(false);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [updateDialogShown, setUpdateDialogShown] = useState(false);
  const tabsRef = useRef<Tab[]>([]);
  const activeTabIdRef = useRef<string>("home");
  const activeLeafByGroupRef = useRef<Record<string, string>>({});
  const closedHistoryRef = useRef<ClosedRecordV1[]>([]);
  const groupsRef = useRef<Group[]>([]);
  const activitiesRef = useRef<ActivityByTabId>({});
  const planOperationRef = useRef(0);
  const notificationPreferencesRef = useRef(notificationPreferences);
  const nativeNotificationPermissionRef = useRef(false);
  const notificationsReadyRef = useRef(false);
  const windowFocusedRef = useRef(true);

  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
  useEffect(() => { activeTabIdRef.current = activeTabId; }, [activeTabId]);
  useEffect(() => { activeLeafByGroupRef.current = activeLeafByGroup; }, [activeLeafByGroup]);
  useEffect(() => { closedHistoryRef.current = closedHistory; }, [closedHistory]);
  useEffect(() => { groupsRef.current = groups; }, [groups]);
  useEffect(() => { activitiesRef.current = activities; }, [activities]);
  useEffect(() => { notificationPreferencesRef.current = notificationPreferences; }, [notificationPreferences]);
  useEffect(() => { nativeNotificationPermissionRef.current = nativeNotificationPermission; }, [nativeNotificationPermission]);
  useEffect(() => { notificationsReadyRef.current = notificationsReady; }, [notificationsReady]);

  useEffect(() => {
    if (!appNotice) return;
    const timer = window.setTimeout(() => setAppNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [appNotice]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const appWindow = getCurrentWindow();
    void appWindow.isFocused().then(focused => {
      if (!cancelled) {
        windowFocusedRef.current = focused;
        setIsWindowFocused(focused);
      }
    }).catch(() => {});
    void appWindow.onFocusChanged(({ payload }) => {
      if (!cancelled) {
        windowFocusedRef.current = payload;
        setIsWindowFocused(payload);
      }
    }).then(dispose => { unlisten = dispose; }).catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void isPermissionGranted()
      .then(granted => {
        if (!cancelled) setNativeNotificationPermission(granted);
      })
      .catch(() => {
        if (!cancelled) setNativeNotificationPermission(false);
      })
      .finally(() => {
        if (!cancelled) setNotificationsReady(true);
      });
    return () => { cancelled = true; };
  }, []);

  const handleSetNotificationPreferences = useCallback((value: AgentNotificationPreferences) => {
    setNotificationPreferences(sanitizeAgentNotificationPreferences(value));
  }, []);

  const handleRequestNotificationPermission = useCallback(async (): Promise<boolean> => {
    try {
      const granted = await isPermissionGranted() || await requestPermission() === "granted";
      setNativeNotificationPermission(granted);
      if (granted) {
        setNotificationPreferences(previous => ({ ...previous, enabled: true }));
      }
      return granted;
    } catch {
      setNativeNotificationPermission(false);
      return false;
    }
  }, []);

  const handleActivityEvent = useCallback((tabId: string, event: ActivityEvent) => {
    const tab = tabsRef.current.find(candidate => candidate.id === tabId);
    if (!tab) return;
    const terminalKind = (tab.shellMode || "claude") === "raw" ? "raw" : "agent";
    const previous = activitiesRef.current[tabId] || createTerminalActivity(terminalKind, event.at);
    const focusedLeaf = tab.groupId
      ? activeTabIdRef.current === tab.groupId && activeLeafByGroupRef.current[tab.groupId] === tabId
      : activeTabIdRef.current === tabId;
    const context = {
      isWindowFocused: windowFocusedRef.current,
      isTargetVisible: focusedLeaf,
      nativePermissionGranted: nativeNotificationPermissionRef.current,
      notificationsReady: notificationsReadyRef.current,
    };
    const next = reduceTerminalActivity(previous, event, {
      isAttended: context.isWindowFocused && focusedLeaf,
    });
    if (next === previous) return;

    const updated = { ...activitiesRef.current, [tabId]: next };
    activitiesRef.current = updated;
    setActivities(updated);

    if (notificationDecision(previous, next, event, notificationPreferencesRef.current, context) === "send") {
      const body = next.reason === "permission"
        ? "An agent is waiting for permission."
        : next.reason === "agent-failed" || next.reason === "spawn-error" || next.reason === "process-exit"
          ? "An agent session needs attention."
          : next.reason === "input"
            ? "An agent is waiting for input."
            : "An agent turn completed.";
      try {
        sendNotification({ title: "xshell", body });
      } catch {
        // Tab indicators and the taskbar overlay remain authoritative when native toasts fail.
      }
    }
  }, []);

  useEffect(() => {
    if (!tabsRestored) return;
    let cancelled = false;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const events = await invoke<PolledActivityEvent[]>("poll_activity_events");
        if (!cancelled) {
          for (const { tabId, ...event } of events) {
            handleActivityEvent(tabId, event as HookActivityEvent);
          }
        }
      } catch {
        // Hook integration is optional; PTY phases still work without the bridge.
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = window.setInterval(poll, 500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [tabsRestored, handleActivityEvent]);

  useEffect(() => {
    const group = groups.find(candidate => candidate.id === activeTabId);
    const leafId = group
      ? activeLeafByGroup[group.id] || collectLeafIds(group.layout)[0]
      : tabs.some(tab => tab.id === activeTabId) ? activeTabId : null;
    if (!leafId) return;
    const acknowledged = acknowledgeTerminalActivities(activitiesRef.current, [leafId]);
    if (acknowledged !== activitiesRef.current) {
      activitiesRef.current = acknowledged;
      setActivities(acknowledged);
    }
  }, [activeTabId, activeLeafByGroup, groups, tabs, isWindowFocused]);

  useEffect(() => {
    const liveIds = new Set(tabs.map(tab => tab.id));
    const entries = Object.entries(activitiesRef.current).filter(([id]) => liveIds.has(id));
    if (entries.length === Object.keys(activitiesRef.current).length) return;
    const next = Object.fromEntries(entries);
    activitiesRef.current = next;
    setActivities(next);
  }, [tabs]);

  const unreadActivityCount = Object.values(activities).filter(activity => activity.unread).length;
  const overlayBytesRef = useRef<Uint8Array | null>(null);
  useEffect(() => {
    let cancelled = false;
    const appWindow = getCurrentWindow();
    if (unreadActivityCount === 0) {
      void appWindow.setOverlayIcon(undefined).catch(() => {});
      void appWindow.setBadgeCount(undefined).catch(() => {});
      return () => { cancelled = true; };
    }
    void (async () => {
      try {
        if (!overlayBytesRef.current) {
          const response = await fetch(activityOverlayUrl);
          if (!response.ok) throw new Error("overlay icon unavailable");
          overlayBytesRef.current = new Uint8Array(await response.arrayBuffer());
        }
        if (!cancelled) await appWindow.setOverlayIcon(overlayBytesRef.current);
      } catch {
        // Overlay support is Windows-only; other platforms use their native badge count.
      }
      if (!cancelled) void appWindow.setBadgeCount(unreadActivityCount).catch(() => {});
    })();
    return () => { cancelled = true; };
  }, [unreadActivityCount]);

  const applyWindowState = useCallback((
    state: ReturnType<typeof createWindowState>,
    options: { confirmNewCommands?: boolean } = {},
  ) => {
    const decoded = decodeRuntimeWindowState(state, { confirmCommands: false });
    const gated = options.confirmNewCommands
      ? requireConfirmationForNewCommandTabs(decoded, tabsRef.current)
      : decoded;
    const runtime = preservePendingCommandConfirmations(
      gated,
      tabsRef.current,
    );
    setTabs(runtime.tabs);
    setGroups(runtime.groups);
    setActiveTabId(runtime.activeEntryId);
    setActiveLeafByGroup(runtime.activeLeafByGroup);
  }, []);

  const handleCommandLaunchConfirmed = useCallback((tabId: string) => {
    setTabs(previous => previous.map(tab => tab.id === tabId
      ? { ...tab, requiresLaunchConfirmation: false }
      : tab));
  }, []);

  // Suppress the WebView's native right-click menu (Back / Reload / Save / Print) app-wide —
  // it's never useful in a desktop app and collides with our own context menus. Still allowed
  // on text fields so the OS cut/copy/paste menu works there.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);

  // ── Initial load ──────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const store = await load("settings.json", { defaults: {}, autoSave: true });
        const [paths, icons, savedTabs, savedGroups, gitLazy, bgColor, aot, shell, ctxEnabled, defFont, gitTree, fileExpOnStart, storedLayout, rlSidebar, rowMetrics, storedTheme, fsRender, termHeaderStats, projectStatsChart, statsView, syncOut, eagerInit, webgl, fontWeight, defAgent, rowMetricsCodex, rlSidebarCodex, rowMetricsOpencode] = await Promise.all([
          store.get<string[]>("project_paths"),
          store.get<Record<string, ProjectSettings>>("project_icons"),
          store.get<Tab[]>("open_tabs"),
          store.get<Group[]>("open_groups"),
          store.get<boolean>("git_lazy_polling"),
          store.get<string>("terminal_bg_color"),
          store.get<boolean>("always_on_top"),
          store.get<string>("default_shell"),
          store.get<boolean>("context_tree_enabled"),
          store.get<number>("default_terminal_font_size"),
          store.get<boolean>("git_changes_tree"),
          store.get<boolean>("file_explorer_on_start"),
          store.get<SidebarItem[]>("sidebar_layout"),
          store.get<boolean>("rate_limit_in_sidebar"),
          store.get<boolean>("session_row_metrics"),
          store.get<ThemeMode>("theme"),
          store.get<boolean>("fullscreen_rendering_enabled"),
          store.get<boolean>("terminal_header_stats"),
          store.get<boolean>("project_stats_chart"),
          store.get<'cost' | 'tokens'>("project_stats_view"),
          store.get<boolean>("force_sync_output_enabled"),
          store.get<boolean>("eager_init_tabs"),
          store.get<boolean>("webgl_rendering_enabled"),
          store.get<number>("terminal_font_weight"),
          store.get<string>("default_agent"),
          store.get<boolean>("session_row_metrics_codex"),
          store.get<boolean>("rate_limit_in_sidebar_codex"),
          store.get<boolean>("session_row_metrics_opencode"),
        ]);
        const [storedWindowState, storedInteractionSettings, storedRestoreUnpinned, storedWorkspaces, storedLaunchRecipes, storedNotificationPreferences] = await Promise.all([
          store.get<unknown>("window_state_v1"),
          store.get<unknown>("interaction_settings_v1"),
          store.get<boolean>("restore_unpinned_tabs"),
          store.get<unknown[]>("workspaces_v1"),
          store.get<unknown[]>("launch_recipes_v1"),
          store.get<unknown>("agent_notification_preferences_v1"),
        ]);
        setInteractionSettings(sanitizeInteractionSettings(storedInteractionSettings));
        setNotificationPreferences(sanitizeAgentNotificationPreferences(storedNotificationPreferences));
        const shouldRestoreUnpinned = typeof storedRestoreUnpinned === "boolean" ? storedRestoreUnpinned : true;
        setRestoreUnpinnedTabs(shouldRestoreUnpinned);
        if (Array.isArray(storedWorkspaces)) {
          const valid: WorkspaceV1[] = [];
          for (const value of storedWorkspaces) {
            const decoded = decodeWorkspace(value);
            if (decoded.ok) valid.push(decoded.value);
          }
          setWorkspaces(valid);
        }
        if (Array.isArray(storedLaunchRecipes)) {
          const valid: LaunchRecipeV1[] = [];
          for (const value of storedLaunchRecipes) {
            const decoded = decodeLaunchRecipe(value);
            if (decoded.ok) valid.push(decoded.value);
          }
          setLaunchRecipes(valid);
        }
        // Layout: prefer the explicit `sidebar_layout` if present; otherwise migrate
        // from the flat `project_paths` list by wrapping each path in a project item.
        let layout: SidebarItem[] = [];
        if (Array.isArray(storedLayout) && storedLayout.length > 0) {
          layout = storedLayout;
        } else if (paths && paths.length > 0) {
          layout = paths.map(p => ({ kind: "project" as const, path: p }));
        }
        setSidebarLayout(layout);
        // Derive the flat paths list from the layout so downstream code stays happy.
        const derivedPaths = flattenSidebarPaths(layout);
        if (derivedPaths.length) setSavedPaths(derivedPaths);
        else if (paths) setSavedPaths(paths);
        if (icons) setProjectIcons(icons);
        if (typeof gitLazy === "boolean") setGitLazyPolling(gitLazy);
        if (typeof bgColor === "string") setTerminalBgColor(bgColor);
        if (typeof aot === "boolean") setAlwaysOnTop(aot);
        if (typeof shell === "string") setDefaultShell(shell);
        if (typeof ctxEnabled === "boolean") setContextTreeEnabled(ctxEnabled);
        if (typeof defFont === "number" && defFont >= 8 && defFont <= 32) setDefaultTerminalFontSize(defFont);
        if (typeof rlSidebar === "boolean") setShowRateLimitInSidebar(rlSidebar);
        if (typeof rowMetrics === "boolean") setShowSessionRowMetrics(rowMetrics);
        if (typeof gitTree === "boolean") setGitChangesTree(gitTree);
        if (typeof fileExpOnStart === "boolean") setFileExplorerOnStart(fileExpOnStart);
        if (typeof fsRender === "boolean") setFullscreenRendering(fsRender);
        if (typeof syncOut === "boolean") setForceSyncOutput(syncOut);
        if (typeof eagerInit === "boolean") setEagerInitTabs(eagerInit);
        if (typeof webgl === "boolean") setWebglRendering(webgl);
        if (typeof fontWeight === "number" && fontWeight >= 100 && fontWeight <= 700) setTerminalFontWeight(fontWeight);
        if (typeof termHeaderStats === "boolean") setShowTerminalHeaderStats(termHeaderStats);
        if (typeof projectStatsChart === "boolean") setShowProjectStatsChart(projectStatsChart);
        if (storedTheme === "light" || storedTheme === "dark") setTheme(storedTheme);
        if (statsView === "cost" || statsView === "tokens") setProjectStatsView(statsView);
        if (defAgent === "ask" || (typeof defAgent === "string" && (AGENT_IDS as string[]).includes(defAgent))) setDefaultAgent(defAgent as "ask" | AgentId);
        if (typeof rowMetricsCodex === "boolean") setShowSessionRowMetricsCodex(rowMetricsCodex);
        if (typeof rlSidebarCodex === "boolean") setShowRateLimitInSidebarCodex(rlSidebarCodex);
        if (typeof rowMetricsOpencode === "boolean") setShowSessionRowMetricsOpencode(rowMetricsOpencode);
        const decodedWindow = storedWindowState === undefined
          ? migrateLegacyWindowState({ open_tabs: savedTabs || [], open_groups: savedGroups || [] })
          : decodeWindowState(storedWindowState);
        if (decodedWindow.ok) {
          const startupState = filterStartupWindowState(decodedWindow.value, shouldRestoreUnpinned);
          const runtime = decodeRuntimeWindowState(startupState);
          setTabs(runtime.tabs);
          setGroups(runtime.groups);
          setActiveTabId(runtime.activeEntryId);
          setActiveLeafByGroup(runtime.activeLeafByGroup);
          let maxN = 0;
          for (const group of runtime.groups) {
            const match = /^Group\s+(\d+)$/.exec(group.name);
            if (match) maxN = Math.max(maxN, parseInt(match[1], 10));
          }
          groupCounterRef.current = maxN + 1;
        }
      } catch (_) {}
      setTabsRestored(true);
      const [projects, sessions] = await Promise.all([
        invoke<ProjectInfo[]>("list_claude_projects").catch(() => [] as ProjectInfo[]),
        invoke<SessionInfo[]>("get_all_recent_sessions", { limit: 100 }).catch(() => [] as SessionInfo[]),
      ]);
      setAllProjects(projects);
      setRecentSessions(sessions);
      setInitialLoading(false);
    })();
  }, []);

  // ── Load the last skipped-update version from the store ───────────
  useEffect(() => {
    (async () => {
      try {
        const store = await load("settings.json", { defaults: {}, autoSave: true });
        const v = await store.get<string>("last_seen_update_version");
        if (typeof v === "string") setLastSeenUpdateVersion(v);
      } catch (_) {}
      setLastSeenLoaded(true);
    })();
  }, []);

  // Open the update dialog once per launch, only if the user hasn't already skipped this
  // exact version. `updateDialogShown` ensures it never re-opens within the same session
  // even if the hook re-renders.
  useEffect(() => {
    if (!lastSeenLoaded || updateDialogShown) return;
    if (updateInfo.loading || updateInfo.error) return;
    if (!updateInfo.updateAvailable || !updateInfo.latestVersion) return;
    if (lastSeenUpdateVersion === updateInfo.latestVersion) return;
    setUpdateDialogOpen(true);
    setUpdateDialogShown(true);
  }, [lastSeenLoaded, updateDialogShown, updateInfo.loading, updateInfo.error, updateInfo.updateAvailable, updateInfo.latestVersion, lastSeenUpdateVersion]);

  // Any close path through the dialog runs through here. Always persists `last_seen_update_version`
  // so the dialog won't fire again until GitHub ships a NEWER tag — the badge + About dot are
  // unaffected and stay until the bundled version actually catches up.
  const dismissUpdateDialog = useCallback(async () => {
    const v = updateInfo.latestVersion;
    setUpdateDialogOpen(false);
    if (!v) return;
    setLastSeenUpdateVersion(v);
    try {
      const store = await load("settings.json", { defaults: {}, autoSave: true });
      await store.set("last_seen_update_version", v);
    } catch (_) {}
  }, [updateInfo.latestVersion]);

  // ── Derive user projects ──────────────────────────────────────────
  useEffect(() => {
    setUserProjects(savedPaths.map(path => {
      const found = allProjects.find(p => p.path.toLowerCase() === path.toLowerCase());
      if (found) return found;
      const name = path.split(/[\\/]/).filter(Boolean).pop() || path;
      return { name, path, encoded_name: "", session_count: 0, last_active: "" };
    }));
  }, [savedPaths, allProjects]);

  // ── Tab title sync: lightweight poll only when terminals are open ──
  useEffect(() => {
    if (tabs.length === 0) return;

    const syncTitles = async () => {
      // Distinct original-cased project paths across open tabs (encoding is case-sensitive).
      const origPaths = [...new Map(tabs.filter(t => t.projectPath).map(t => [t.projectPath!.toLowerCase(), t.projectPath!])).values()];
      const projectMap = new Map<string, ProjectInfo>();
      for (const p of allProjects) projectMap.set(p.path.toLowerCase(), p);

      for (const origPath of origPaths) {
        const pp = origPath.toLowerCase();
        // Prefer Claude's recorded encoded name; otherwise mirror the Rust encoding so the
        // poll also reaches Codex/Cursor-only projects (which carry no Claude encoded_name).
        const encodedName = projectMap.get(pp)?.encoded_name || origPath.replace(/[^a-zA-Z0-9]/g, "-");
        if (!encodedName) continue;
        try {
          const sessions = await invoke<SessionInfo[]>("get_sessions", { encodedName });
          setTabs(prev => {
            let changed = false;
            // Sessions already linked to an open tab — an unlinked tab must not claim them.
            const claimed = new Set(prev.map(t => t.sessionId).filter(Boolean) as string[]);
            const next = prev.map(tab => {
              if (tab.projectPath?.toLowerCase() !== pp) return tab;
              // Link an unlinked new-chat tab (Codex — which has no pre-created id — or a Cursor
              // tab whose create-chat fell back) to its freshly-created session: newest unclaimed
              // session of the same agent that appeared after the tab opened and already has a
              // real title (not the bare "Session <id>" fallback), so we rename straight to the
              // meaningful name instead of flashing an intermediate one.
              if (!tab.sessionId && tab.agent && tab.agent !== "claude") {
                const candidate = sessions
                  .filter(s => s.agent === tab.agent && !claimed.has(s.id) && !s.title.startsWith("Session ") && new Date(s.timestamp).getTime() >= (tab.createdAt ?? 0))
                  .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
                if (candidate) { claimed.add(candidate.id); changed = true; return { ...tab, sessionId: candidate.id, title: candidate.title }; }
                return tab;
              }
              // Linked tab: keep its title in sync — picks up `/rename`, ai-title, first-prompt alike.
              if (!tab.sessionId) return tab;
              const match = sessions.find(s => s.id === tab.sessionId);
              if (match && match.title !== tab.title) { changed = true; return { ...tab, title: match.title }; }
              return tab;
            });
            return changed ? next : prev;
          });
        } catch (_) {}
      }
    };

    const interval = setInterval(syncTitles, 5000);
    return () => clearInterval(interval);
  }, [tabs.length, allProjects]); // Only re-setup when tab count or projects change

  // ── Persistence ───────────────────────────────────────────────────
  const persistPaths = useCallback(async (paths: string[]) => {
    setSavedPaths(paths);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("project_paths", paths); } catch (_) {}
  }, []);

  // Central sidebar-layout mutator. Also refreshes the derived `savedPaths` and persists both
  // so old code paths (which still consume `savedPaths`) keep working.
  const persistSidebarLayout = useCallback(async (layout: SidebarItem[]) => {
    setSidebarLayout(layout);
    const paths = flattenSidebarPaths(layout);
    setSavedPaths(paths);
    try {
      const store = await load("settings.json", { defaults: {}, autoSave: true });
      await store.set("sidebar_layout", layout);
      await store.set("project_paths", paths);
    } catch (_) {}
  }, []);

  const persistIcons = useCallback(async (icons: Record<string, ProjectSettings>) => {
    setProjectIcons(icons);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("project_icons", icons); } catch (_) {}
  }, []);

  const persistGitLazyPolling = useCallback(async (enabled: boolean) => {
    setGitLazyPolling(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("git_lazy_polling", enabled); } catch (_) {}
  }, []);

  const persistGitChangesTree = useCallback(async (enabled: boolean) => {
    setGitChangesTree(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("git_changes_tree", enabled); } catch (_) {}
  }, []);

  const persistFileExplorerOnStart = useCallback(async (enabled: boolean) => {
    setFileExplorerOnStart(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("file_explorer_on_start", enabled); } catch (_) {}
  }, []);

  const persistContextTreeEnabled = useCallback(async (enabled: boolean) => {
    setContextTreeEnabled(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("context_tree_enabled", enabled); } catch (_) {}
  }, []);

  const persistShowRateLimitInSidebar = useCallback(async (enabled: boolean) => {
    setShowRateLimitInSidebar(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("rate_limit_in_sidebar", enabled); } catch (_) {}
  }, []);

  const persistShowRateLimitInSidebarCodex = useCallback(async (enabled: boolean) => {
    setShowRateLimitInSidebarCodex(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("rate_limit_in_sidebar_codex", enabled); } catch (_) {}
  }, []);

  const persistShowSessionRowMetrics = useCallback(async (enabled: boolean) => {
    setShowSessionRowMetrics(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("session_row_metrics", enabled); } catch (_) {}
  }, []);

  const persistShowSessionRowMetricsCodex = useCallback(async (enabled: boolean) => {
    setShowSessionRowMetricsCodex(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("session_row_metrics_codex", enabled); } catch (_) {}
  }, []);

  const persistShowSessionRowMetricsOpencode = useCallback(async (enabled: boolean) => {
    setShowSessionRowMetricsOpencode(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("session_row_metrics_opencode", enabled); } catch (_) {}
  }, []);

  const persistShowTerminalHeaderStats = useCallback(async (enabled: boolean) => {
    setShowTerminalHeaderStats(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("terminal_header_stats", enabled); } catch (_) {}
  }, []);

  const persistShowProjectStatsChart = useCallback(async (enabled: boolean) => {
    setShowProjectStatsChart(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("project_stats_chart", enabled); } catch (_) {}
  }, []);

  const persistDefaultTerminalFontSize = useCallback(async (size: number) => {
    const clamped = Math.max(8, Math.min(32, Math.round(size)));
    setDefaultTerminalFontSize(clamped);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("default_terminal_font_size", clamped); } catch (_) {}
  }, []);

  const persistTerminalBgColor = useCallback(async (color: string) => {
    setTerminalBgColor(color);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("terminal_bg_color", color); } catch (_) {}
  }, []);

  const persistAlwaysOnTop = useCallback(async (value: boolean) => {
    setAlwaysOnTop(value);
    try { await getCurrentWindow().setAlwaysOnTop(value); } catch (_) {}
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("always_on_top", value); } catch (_) {}
  }, []);

  const persistDefaultShell = useCallback(async (shellId: string) => {
    setDefaultShell(shellId);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("default_shell", shellId); } catch (_) {}
  }, []);

  const persistFullscreenRendering = useCallback(async (enabled: boolean) => {
    setFullscreenRendering(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("fullscreen_rendering_enabled", enabled); } catch (_) {}
  }, []);

  const persistProjectStatsView = useCallback(async (view: 'cost' | 'tokens') => {
    setProjectStatsView(view);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("project_stats_view", view); } catch (_) {}
  }, []);

  const persistForceSyncOutput = useCallback(async (enabled: boolean) => {
    setForceSyncOutput(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("force_sync_output_enabled", enabled); } catch (_) {}
  }, []);

  const persistEagerInitTabs = useCallback(async (enabled: boolean) => {
    setEagerInitTabs(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("eager_init_tabs", enabled); } catch (_) {}
  }, []);

  const persistWebglRendering = useCallback(async (enabled: boolean) => {
    setWebglRendering(enabled);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("webgl_rendering_enabled", enabled); } catch (_) {}
  }, []);

  const persistTerminalFontWeight = useCallback(async (weight: number) => {
    setTerminalFontWeight(weight);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("terminal_font_weight", weight); } catch (_) {}
  }, []);

  // Apply synchronously alongside the React state change so the next paint already has
  // the new tokens — avoids a flash and any useEffect-timing oddities in the WebView.
  const persistTheme = useCallback(async (next: ThemeMode) => {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("theme", next); } catch (_) {}
  }, []);

  const persistDefaultAgent = useCallback(async (next: "ask" | AgentId) => {
    setDefaultAgent(next);
    try { const store = await load("settings.json", { defaults: {}, autoSave: true }); await store.set("default_agent", next); } catch (_) {}
  }, []);

  // Safety net: keep the attribute in sync with state on every change (covers the initial
  // restore from settings.json, where setTheme is called outside persistTheme).
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // When the theme flips, slide the terminal bg setting from the previous theme's default
  // to the new theme's default — so the Settings color picker shows the right shade and
  // the saved value matches what's actually rendered. Custom colors stay put. Also fires
  // on first load: if the user originally saved #1c1c1b in dark and then picked Light,
  // this normalizes them to #faf9f5 once the stored theme is restored.
  useEffect(() => {
    const newDefault = theme === "light" ? LIGHT_TERM_BG : DARK_TERM_BG;
    const oldDefault = theme === "light" ? DARK_TERM_BG : LIGHT_TERM_BG;
    if (terminalBgColor.toLowerCase() === oldDefault) persistTerminalBgColor(newDefault);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  // Called by TerminalTab when a branched session is detected. Updates only the tab's
  // metadata — the PTY is already attached to the new sessionId's JSONL, so nothing else
  // needs to change.
  const handleSwitchTabToBranch = useCallback((tabId: string, newSessionId: string, newTitle: string) => {
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, sessionId: newSessionId, title: newTitle } : t));
  }, []);

  // Apply always-on-top on startup once the value has been restored from disk.
  useEffect(() => { getCurrentWindow().setAlwaysOnTop(alwaysOnTop).catch(() => {}); }, [alwaysOnTop]);


  // ── Navigation: fresh load on every navigate ──────────────────────
  const handleSelectProject = useCallback(async (project: ProjectInfo) => {
    setSelectedProject(project);
    setActiveTabId("home");
    // Prefer Claude's recorded encoded name; otherwise mirror the Rust encoding so projects
    // only ever used by Codex/Cursor/opencode (no ~/.claude entry) still list their sessions.
    const encodedName = project.encoded_name || project.path.replace(/[^a-zA-Z0-9]/g, "-");
    if (!encodedName) { setProjectSessions([]); return; }
    setSessionsLoading(true);
    try { setProjectSessions(await invoke<SessionInfo[]>("get_sessions", { encodedName })); } catch (_) { setProjectSessions([]); }
    setSessionsLoading(false);
  }, []);

  const handleGoHome = useCallback(async () => {
    setSelectedProject(null);
    setActiveTabId("home");
    setSessionsLoading(true);
    const [sessions, projects] = await Promise.all([
      invoke<SessionInfo[]>("get_all_recent_sessions", { limit: 100 }).catch(() => [] as SessionInfo[]),
      invoke<ProjectInfo[]>("list_claude_projects").catch(() => allProjects),
    ]);
    setRecentSessions(sessions);
    setAllProjects(projects);
    setSessionsLoading(false);
  }, [allProjects]);

  // ── Project management ────────────────────────────────────────────
  const handleToggleProject = useCallback(async (path: string) => {
    const exists = flattenSidebarPaths(sidebarLayout).some(p => p.toLowerCase() === path.toLowerCase());
    const next = exists ? removeProjectFromLayout(sidebarLayout, path) : addProjectToLayout(sidebarLayout, path);
    await persistSidebarLayout(next);
    if (exists && selectedProject?.path.toLowerCase() === path.toLowerCase()) setSelectedProject(null);
  }, [sidebarLayout, persistSidebarLayout, selectedProject]);

  const handleRemoveProject = useCallback(async (path: string) => {
    await persistSidebarLayout(removeProjectFromLayout(sidebarLayout, path));
    if (selectedProject?.path.toLowerCase() === path.toLowerCase()) { setSelectedProject(null); setActiveTabId("home"); }
  }, [sidebarLayout, persistSidebarLayout, selectedProject]);

  const handleSaveProjectSettings = useCallback(async (path: string, next: ProjectSettings) => {
    const key = path.toLowerCase();
    const existing = projectIcons[key] || {};
    // Editor only touches icon + color + customName; preserve folders that already exist.
    const entry: ProjectSettings = { ...existing, icon: next.icon, color: next.color, customName: next.customName };
    const merged: Record<string, ProjectSettings> = { ...projectIcons, [key]: entry };
    if (!entry.icon && !entry.color && !entry.customName && (!entry.folders || entry.folders.length === 0)) delete merged[key];
    await persistIcons(merged);
  }, [projectIcons, persistIcons]);

  const handleSaveFolders = useCallback(async (path: string, folders: SessionFolder[]) => {
    const key = path.toLowerCase();
    const existing = projectIcons[key] || {};
    const entry: ProjectSettings = { ...existing, folders: folders.length > 0 ? folders : undefined };
    const merged: Record<string, ProjectSettings> = { ...projectIcons, [key]: entry };
    if (!entry.icon && !entry.customName && (!entry.folders || entry.folders.length === 0)) delete merged[key];
    await persistIcons(merged);
  }, [projectIcons, persistIcons]);

  const handleBrowseFolder = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: "Select project folder" });
      if (selected && typeof selected === "string" && !flattenSidebarPaths(sidebarLayout).some(p => p.toLowerCase() === selected.toLowerCase())) {
        await persistSidebarLayout(addProjectToLayout(sidebarLayout, selected));
        setAllProjects(await invoke<ProjectInfo[]>("list_claude_projects"));
      }
    } catch (_) {}
  }, [sidebarLayout, persistSidebarLayout]);

  // ── Tab management ────────────────────────────────────────────────
  const handleOpenSession = useCallback((session: SessionInfo, project?: ProjectInfo) => {
    const existingTab = tabs.find(t => t.sessionId === session.id);
    if (existingTab) {
      if (existingTab.groupId) {
        // Tab lives inside a group — surface that group and focus the matching pane.
        setActiveTabId(existingTab.groupId);
        setActiveLeafByGroup(prev => ({ ...prev, [existingTab.groupId!]: existingTab.id }));
      } else {
        setActiveTabId(existingTab.id);
      }
      return;
    }
    // Unique tab id (not derived from session id) — otherwise, a tab that auto-switches
    // its sessionId after /branch would leave its original session id "free", and a later
    // re-open of that session would generate a colliding tab id.
    const tabId = `terminal-${session.id}-${Date.now().toString(36)}`;
    setTabs(prev => [...prev, { id: tabId, type: "terminal", title: session.title, sessionId: session.id, agent: session.agent, projectPath: session.project_path || project?.path || "", projectName: session.project_name || project?.name || "", lastActiveAt: Date.now() }]);
    setActiveTabId(tabId);
  }, [tabs]);

  // Add as tab without switching to it — stays on current view.
  const handleOpenSessionBackground = useCallback((session: SessionInfo, project?: ProjectInfo) => {
    const existingTab = tabs.find(t => t.sessionId === session.id);
    if (existingTab) return;
    const tabId = `terminal-${session.id}-${Date.now().toString(36)}`;
    setTabs(prev => [...prev, { id: tabId, type: "terminal", title: session.title, sessionId: session.id, agent: session.agent, projectPath: session.project_path || project?.path || "", projectName: session.project_name || project?.name || "", lastActiveAt: Date.now() }]);
  }, [tabs]);

  const handleNewChat = useCallback((project: ProjectInfo, agent?: AgentId) => {
    // Resolve which agent hosts the chat: explicit pick > single installed agent > the
    // user's default. With multiple agents and no default ("ask"), open the picker dialog
    // and re-enter with the chosen agent. Single-agent machines never see any of this.
    if (!agent) {
      const installed = AGENT_IDS.filter(a => installedAgents[a]);
      if (installed.length > 1) {
        if (defaultAgent !== "ask") agent = defaultAgent;
        else { setAgentPickerProject(project); return; }
      } else {
        agent = installed[0] ?? "claude";
      }
    }
    const tabId = `terminal-new-${Date.now()}`;
    const base = { id: tabId, type: "terminal" as const, title: "New Chat", projectPath: project.path, projectName: project.name, shellMode: "claude" as const, lastActiveAt: Date.now(), createdAt: Date.now() };
    if (agent === "claude") {
      // Pre-allocate a UUID and pass it to Claude via `--session-id`. Two wins over the old
      // `-n Chat-xxxxxx` approach: (1) we know the JSONL filename from the start, so the polling
      // sync can match by sessionId immediately instead of racing on customTitle; (2) Claude's
      // `ai-title` summary actually fires (it's suppressed when customTitle is set).
      setTabs(prev => [...prev, { ...base, sessionId: crypto.randomUUID(), agent: "claude" as const }]);
    } else {
      // Codex and Cursor can't pre-assign a session id, so spawn the agent bare in the project
      // cwd — instant, like Claude. The session id only exists once the agent writes it, so the
      // tab starts unlinked; the title-sync links it (and renames the tab) once a session with a
      // real title appears.
      setTabs(prev => [...prev, { ...base, agent }]);
    }
    setActiveTabId(tabId);
  }, [installedAgents, defaultAgent]);

  // Open a raw shell tab (no Claude wrapping) — disposable by design, not persisted across restart.
  // project === null → shell spawned in the user's home directory.
  const handleNewShell = useCallback((project: ProjectInfo | null, shellId: string, shellName: string) => {
    const tabId = `terminal-shell-${Date.now()}`;
    setTabs(prev => [...prev, { id: tabId, type: "terminal" as const, title: shellName, projectPath: project?.path || "", projectName: project?.name || "~", shellMode: "raw", shellId, lastActiveAt: Date.now() }]);
    setActiveTabId(tabId);
  }, []);

  const [closingTabIds, setClosingTabIds] = useState<Set<string>>(new Set());

  const handleCloseTab = useCallback((id: string) => {
    const current = createWindowState(
      tabsRef.current,
      groupsRef.current,
      activeTabIdRef.current,
      activeLeafByGroupRef.current,
    );
    const result = closeWindowEntry(current, closedHistoryRef.current, id);
    if (!result.ok) {
      setAppNotice(result.message);
      return;
    }
    setClosedHistory(result.history);
    applyWindowState(result.state);
  }, [applyWindowState]);

  const handleReopenClosed = useCallback(() => {
    const current = createWindowState(
      tabsRef.current,
      groupsRef.current,
      activeTabIdRef.current,
      activeLeafByGroupRef.current,
    );
    const result = undoLastClosed(current, closedHistoryRef.current);
    if (!result.ok) {
      if (result.code !== "empty_history") setAppNotice(result.message);
      return;
    }
    setClosedHistory(result.history);
    applyWindowState(result.state, { confirmNewCommands: true });
  }, [applyWindowState]);

  const handleReorderProjects = useCallback(async (newPaths: string[]) => {
    await persistPaths(newPaths);
  }, [persistPaths]);

  void handleReorderProjects; // kept for any legacy callers; new Sidebar uses onLayoutChange.

  const handleReorderTabs = useCallback((newTabs: Tab[]) => {
    setTabs(newTabs);
  }, []);

  const [hoveredProjectPath, setHoveredProjectPath] = useState<string | null>(null);

  // Active terminal-tab count per project path (used for sidebar badges).
  const activeCountByProject = new Map<string, number>();
  for (const t of tabs) {
    if (t.projectPath) {
      const key = t.projectPath.toLowerCase();
      activeCountByProject.set(key, (activeCountByProject.get(key) || 0) + 1);
    }
  }
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const showSettings = activeTabId === "settings";
  const activeTab = findActiveRuntimeTab(tabs, groups, activeTabId, activeLeafByGroup);
  const activeTabProjectPath = activeTab?.projectPath || null;

  // ── Groups (multi-pane split view) ────────────────────────────
  // A Group bundles up to 8 tabs into one "entry" in the tab bar, displaying them
  // in a binary-tree split layout. A tab is either standalone OR inside one group.
  const MAX_GROUP_LEAVES = 8;
  const showHome = !showSettings && !tabs.find(t => t.id === activeTabId) && !groups.find(g => g.id === activeTabId);

  // Window topology is persisted as one validated record. The legacy split keys are only
  // read during migration, which removes the crash window where tabs and groups could tear.
  useEffect(() => {
    if (!tabsRestored) return;
    (async () => {
      try {
        const state = createWindowState(tabs, groups, activeTabId, activeLeafByGroup);
        if (validateWindowState(state).length > 0) return;
        const store = await load("settings.json", { defaults: {}, autoSave: true });
        await store.set("window_state_v1", state);
      } catch (_) {}
    })();
  }, [tabs, groups, activeTabId, activeLeafByGroup, tabsRestored]);

  useEffect(() => {
    if (!tabsRestored) return;
    (async () => {
      try {
        const store = await load("settings.json", { defaults: {}, autoSave: true });
        await Promise.all([
          store.set("interaction_settings_v1", interactionSettings),
          store.set("restore_unpinned_tabs", restoreUnpinnedTabs),
          store.set("workspaces_v1", workspaces),
          store.set("launch_recipes_v1", launchRecipes),
          store.set("agent_notification_preferences_v1", notificationPreferences),
        ]);
      } catch (_) {}
    })();
  }, [interactionSettings, restoreUnpinnedTabs, workspaces, launchRecipes, notificationPreferences, tabsRestored]);
  // Which leaf inside an active group currently has focus (receives input).
  // Live drag state: which tab is being dragged, which leaf it's hovering over, which edge zone.
  const [dragOver, setDragOver] = useState<{ tabId: string; targetTabId: string | null; zone: DropZone | null } | null>(null);
  // Pointer position for rendering the floating drag ghost.
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const workAreaRef = useRef<HTMLDivElement>(null);

  // Stable DOM host per terminal tab — owned imperatively so React's reconciliation never
  // destroys them. Each host receives a portal-rendered <TerminalTab/> and is physically
  // reparented into the right slot (or the parking area) after every layout render.
  const terminalHostsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const parkingRef = useRef<HTMLDivElement>(null);
  const ensureHost = useCallback((tabId: string) => {
    let host = terminalHostsRef.current.get(tabId);
    if (!host) {
      host = document.createElement("div");
      host.className = "terminal-host";
      host.style.width = "100%";
      host.style.height = "100%";
      host.style.display = "flex";
      terminalHostsRef.current.set(tabId, host);
    }
    return host;
  }, []);

  // Global capture-phase listener: when the user clicks anywhere inside a pane belonging
  // to a group, mark that leaf as the focused one. We do this at the document level so
  // xterm's own internal event handlers can't shadow it.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (!tgt) return;
      const pane = tgt.closest("[data-group-leaf]") as HTMLElement | null;
      if (!pane) return;
      const leafId = pane.getAttribute("data-group-leaf");
      if (!leafId) return;
      const tab = tabsRef.current.find(t => t.id === leafId);
      if (!tab?.groupId) return;
      setActiveLeafByGroup(prev => (prev[tab.groupId!] === leafId ? prev : { ...prev, [tab.groupId!]: leafId }));
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);

  // Bump lastActiveAt on the currently focused tab whenever activeTabId or the focused
  // leaf inside a group changes. Powers the "recent" sort in the tab search dialog.
  useEffect(() => {
    const group = groupsRef.current.find(g => g.id === activeTabId);
    const id = group ? (activeLeafByGroup[activeTabId] || collectLeafIds(group.layout)[0]) : activeTabId;
    if (!id) return;
    const now = Date.now();
    setTabs(prev => {
      const found = prev.find(t => t.id === id);
      if (!found) return prev;
      return prev.map(t => t.id === id ? { ...t, lastActiveAt: now } : t);
    });
  }, [activeTabId, activeLeafByGroup]);

  // After each render: park every terminal host in its current slot (or the parking div).
  // Drop obsolete hosts for tabs that no longer exist.
  useLayoutEffect(() => {
    const liveIds = new Set(tabs.map(t => t.id));
    for (const [id, host] of Array.from(terminalHostsRef.current.entries())) {
      if (!liveIds.has(id)) {
        host.remove();
        terminalHostsRef.current.delete(id);
        continue;
      }
      const slot = document.querySelector(`[data-terminal-slot="${CSS.escape(id)}"]`) as HTMLElement | null;
      const target = slot || parkingRef.current;
      if (target && host.parentElement !== target) target.appendChild(host);
    }
  });

  // Derived: tab bar entries. A tab with groupId doesn't appear standalone — its group does.
  // Walking tabs in order yields a deterministic, order-preserving set of entries.
  // Memoized so the array reference is stable when tabs/groups don't change — the drag-reorder
  // hook in TabBar uses this as its `items` and would otherwise thrash its effect on every render.
  type Entry = { kind: "tab"; id: string; tab: Tab } | { kind: "group"; id: string; group: Group };
  const entries: Entry[] = useMemo(() => {
    const state = createWindowState(tabs, groups, activeTabId, activeLeafByGroup);
    const tabsById = new Map(tabs.map(tab => [tab.id, tab]));
    const groupsById = new Map(groups.map(group => [group.id, group]));
    return state.entryOrder.flatMap((entry): Entry[] => {
      if (entry.kind === "tab") {
        const tab = tabsById.get(entry.id);
        return tab ? [{ kind: "tab", id: tab.id, tab }] : [];
      }
      const group = groupsById.get(entry.id);
      return group ? [{ kind: "group", id: group.id, group }] : [];
    });
  }, [tabs, groups, activeTabId, activeLeafByGroup]);

  // Dissolve a group when it has 0 or 1 leaves left; 1-leaf groups are pointless.
  useEffect(() => {
    const dissolved: string[] = [];
    const updatedTabs: Tab[] = [];
    let changed = false;
    for (const g of groups) {
      const leaves = collectLeafIds(g.layout);
      if (leaves.length <= 1) {
        dissolved.push(g.id);
        changed = true;
      }
    }
    if (!changed) return;
    for (const t of tabs) {
      if (t.groupId && dissolved.includes(t.groupId)) updatedTabs.push({ ...t, groupId: undefined });
      else updatedTabs.push(t);
    }
    setTabs(updatedTabs);
    setGroups(prev => prev.filter(g => !dissolved.includes(g.id)));
    // If the active entry was a dissolved group, switch to the remaining leaf (or home).
    if (dissolved.includes(activeTabIdRef.current)) {
      const survivors = tabs.filter(t => t.groupId && dissolved.includes(t.groupId));
      setActiveTabId(survivors[0]?.id || "home");
    }
  }, [groups, tabs]);

  // Drop a tab into the current work area. If `targetTabId` is a standalone tab, a new
  // group is created containing both. If it's inside a group, the dragged tab is inserted.
  const performDrop = useCallback((draggedTabId: string, targetTabId: string, zone: DropZone) => {
    if (draggedTabId === targetTabId) return;
    const dragged = tabsRef.current.find(t => t.id === draggedTabId);
    const target = tabsRef.current.find(t => t.id === targetTabId);
    if (!dragged || !target) return;
    if (dragged.groupId) return; // Already in a group — not allowed to re-add without removing first.

    if (target.groupId) {
      // Insert into the target's existing group.
      const group = groupsRef.current.find(g => g.id === target.groupId);
      if (!group) return;
      if (countLeaves(group.layout) >= MAX_GROUP_LEAVES) return;
      const newLayout = insertLeaf(group.layout, targetTabId, draggedTabId, zone);
      setGroups(prev => prev.map(g => g.id === group.id ? { ...g, layout: newLayout, pinned: g.pinned || dragged.pinned || undefined } : g));
      setTabs(prev => prev.map(t => t.id === draggedTabId ? { ...t, groupId: group.id, pinned: undefined } : t));
      setActiveTabId(group.id);
      setActiveLeafByGroup(prev => ({ ...prev, [group.id]: draggedTabId }));
    } else {
      // Both tabs are standalone → create a new group with both.
      const id = `group-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const name = `Group ${groupCounterRef.current++}`;
      const direction: "col" | "row" = zone === "left" || zone === "right" ? "col" : "row";
      const draggedLeaf: LayoutNode = { kind: "leaf", tabId: draggedTabId };
      const targetLeaf: LayoutNode = { kind: "leaf", tabId: targetTabId };
      const children: [LayoutNode, LayoutNode] = zone === "left" || zone === "top"
        ? [draggedLeaf, targetLeaf]
        : [targetLeaf, draggedLeaf];
      const layout: LayoutNode = { kind: "split", direction, children, ratio: 0.5 };
      setGroups(prev => [...prev, { id, name, layout, pinned: dragged.pinned || target.pinned || undefined }]);
      setTabs(prev => prev.map(t => (t.id === draggedTabId || t.id === targetTabId) ? { ...t, groupId: id, pinned: undefined } : t));
      setActiveTabId(id);
      setActiveLeafByGroup(prev => ({ ...prev, [id]: draggedTabId }));
    }
  }, []);

  // Close a pane in a group — removes the underlying tab entirely (matches the
  // expectation that × closes that terminal, not just ejects it).
  const closePaneInGroup = useCallback((tabId: string) => {
    const current = createWindowState(
      tabsRef.current,
      groupsRef.current,
      activeTabIdRef.current,
      activeLeafByGroupRef.current,
    );
    const result = closeWindowPane(current, closedHistoryRef.current, tabId);
    if (!result.ok) {
      setAppNotice(result.message);
      return;
    }
    setClosedHistory(result.history);
    applyWindowState(result.state);
  }, [applyWindowState]);

  // Adjust a split's ratio at the given path in the active group's layout tree.
  const updateGroupRatio = useCallback((groupId: string, path: number[], ratio: number) => {
    setGroups(prev => prev.map(g => {
      if (g.id !== groupId) return g;
      const next = setRatioAt(g.layout, path, ratio);
      return { ...g, layout: next };
    }));
  }, []);

  // ── Drag from tab bar → drop on a pane in the work area ───────
  // One pointerdown listener at the app level. It avoids touching useDragReorder so
  // intra-tab-bar reordering still works; once the pointer leaves the tab bar, we
  // enter split-drag mode and start painting drop zones over the pane under the cursor.
  useEffect(() => {
    let startTabId: string | null = null;
    let startX = 0, startY = 0;
    let dragging = false;

    // Find which leaf pane (and which zone of it) the pointer is over.
    const zoneAt = (x: number, y: number): { targetTabId: string | null; zone: DropZone | null } => {
      const area = workAreaRef.current;
      if (!area) return { targetTabId: null, zone: null };
      const areaRect = area.getBoundingClientRect();
      if (x < areaRect.left || x > areaRect.right || y < areaRect.top || y > areaRect.bottom) {
        return { targetTabId: null, zone: null };
      }
      // Pane-aware: if the active entry is a group, we want the specific pane the user
      // is over. Single-tab work areas carry a data-group-leaf on the wrapper.
      const hits = document.elementsFromPoint(x, y);
      let paneEl: HTMLElement | null = null;
      for (const el of hits) {
        const e = el as HTMLElement;
        if (e.dataset && e.dataset.groupLeaf) { paneEl = e; break; }
      }
      if (!paneEl) return { targetTabId: null, zone: null };
      const r = paneEl.getBoundingClientRect();
      const relX = (x - r.left) / r.width;
      const relY = (y - r.top) / r.height;
      // Split the pane into 4 triangles by its diagonals — every point inside the pane
      // falls into exactly one zone, so there's no dead middle.
      const dx = relX - 0.5;
      const dy = relY - 0.5;
      const zone: DropZone = Math.abs(dx) > Math.abs(dy)
        ? (dx < 0 ? "left" : "right")
        : (dy < 0 ? "top" : "bottom");
      return { targetTabId: paneEl.dataset.groupLeaf || null, zone };
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const tgt = e.target as HTMLElement | null;
      if (!tgt || tgt.closest(".tab-item-close")) return;
      const item = tgt.closest(".tab-item[data-drag-id]") as HTMLElement | null;
      if (!item) return;
      const id = item.getAttribute("data-drag-id");
      if (!id) return;
      startTabId = id;
      startX = e.clientX;
      startY = e.clientY;
      dragging = false;
    };
    const onMove = (e: PointerEvent) => {
      if (!startTabId) return;
      const dist = Math.hypot(e.clientX - startX, e.clientY - startY);
      if (!dragging && dist > 10) dragging = true;
      if (!dragging) return;
      const { targetTabId, zone } = zoneAt(e.clientX, e.clientY);
      // If the pointer is still inside the tab bar (no pane under it), let the intra-bar
      // reorder hook own the gesture — don't churn App state or show the split-drag ghost.
      // Return prev from the setters so React bails out (Object.is equality → no re-render).
      setDragOver(prev => {
        if (!prev && !targetTabId) return prev;
        return { tabId: startTabId!, targetTabId, zone };
      });
      setDragPos(prev => {
        if (!targetTabId && !prev) return prev;
        return { x: e.clientX, y: e.clientY };
      });
    };
    const onUp = (e: PointerEvent) => {
      if (startTabId && dragging) {
        const { targetTabId, zone } = zoneAt(e.clientX, e.clientY);
        if (targetTabId && zone) performDrop(startTabId, targetTabId, zone);
      }
      startTabId = null;
      dragging = false;
      setDragOver(null);
      setDragPos(null);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [performDrop]);

  // Sidebar only collapses via explicit user action (button in sidebar top, or chevron in TabBar).

  // Current project context: active terminal's project, or selected project on the project view.
  // Null on home (no context → hide + and dropdown).
  const contextProject: ProjectInfo | null = (() => {
    if (activeTab) {
      if (!activeTabProjectPath) return null;
      const fallbackName = activeTab.projectName
        || activeTabProjectPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop()
        || activeTabProjectPath;
      return allProjects.find(p => p.path.toLowerCase() === activeTabProjectPath.toLowerCase())
        || { name: fallbackName, path: activeTabProjectPath, encoded_name: "", session_count: 0, last_active: "" };
    }
    if (showHome && selectedProject) return selectedProject;
    return null;
  })();

  const launchAvailability = useMemo(() => ({
    installedAgents: new Set(AGENT_IDS.filter(agent => installedAgents[agent])),
    availableShellIds: new Set(getAvailableShells().map(shell => shell.id)),
  }), [installedAgents]);

  const validateWorkspaceDependencies = useCallback(async (workspace: WorkspaceV1): Promise<WorkspaceDependencyProbe> => {
    const paths = workspaceDirectories(workspace);
    const shellIds = workspaceShellIds(workspace, defaultShell);
    const launches = workspaceCommandPreflights(workspace);
    const [missingDirectories, missingShells] = await Promise.all([
      paths.length === 0 ? Promise.resolve([]) : invoke<string[]>("validate_directories", { paths }),
      shellIds.length === 0 ? Promise.resolve([]) : invoke<string[]>("validate_shell_presets", { shellIds }),
      launches.length === 0 ? Promise.resolve() : invoke<void>("validate_command_launches", { launches }),
    ]);
    return { missingDirectories, missingShells };
  }, [defaultShell]);

  const handleCaptureWorkspace = useCallback((name: string): string | null => {
    if (!name.trim()) return "A workspace name is required.";
    const result = captureWorkspace(createWindowState(
      tabsRef.current,
      groupsRef.current,
      activeTabIdRef.current,
      activeLeafByGroupRef.current,
    ), { id: crypto.randomUUID(), name: name.trim() });
    if (!result.ok) return describePlanIssues(result.issues);
    setWorkspaces(previous => [...previous, result.value]);
    return null;
  }, []);

  const handleSaveWorkspace = useCallback((workspace: WorkspaceV1): string | null => {
    const decoded = decodeWorkspace(workspace);
    if (!decoded.ok) return describePlanIssues(decoded.issues);
    setWorkspaces(previous => {
      const index = previous.findIndex(candidate => candidate.id === decoded.value.id);
      if (index < 0) return [...previous, decoded.value];
      const next = [...previous];
      next[index] = decoded.value;
      return next;
    });
    return null;
  }, []);

  const handleDeleteWorkspace = useCallback((id: string) => {
    setWorkspaces(previous => previous.filter(workspace => workspace.id !== id));
  }, []);

  const handleOpenWorkspace = useCallback(async (id: string, mode: "merge" | "replace") => {
    const workspace = workspaces.find(candidate => candidate.id === id);
    if (!workspace) {
      setAppNotice("That workspace no longer exists.");
      return;
    }
    const operation = ++planOperationRef.current;
    let current: ReturnType<typeof createWindowState> | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = createWindowState(tabsRef.current, groupsRef.current, activeTabIdRef.current, activeLeafByGroupRef.current);
      const issues = preflightWorkspace(workspace, candidate, mode, launchAvailability);
      if (issues.length > 0) {
        setAppNotice(describePlanIssues(issues));
        return;
      }
      const effective = effectiveWorkspaceForPreflight(workspace, candidate, mode).workspace;
      let missing: WorkspaceDependencyProbe;
      try {
        missing = await validateWorkspaceDependencies(effective);
      } catch (error) {
        if (operation === planOperationRef.current) setAppNotice(`Workspace preflight failed: ${String(error)}`);
        return;
      }
      if (operation !== planOperationRef.current) return;

      const latest = createWindowState(tabsRef.current, groupsRef.current, activeTabIdRef.current, activeLeafByGroupRef.current);
      const latestIssues = preflightWorkspace(workspace, latest, mode, launchAvailability);
      if (latestIssues.length > 0) {
        setAppNotice(describePlanIssues(latestIssues));
        return;
      }
      const latestEffective = effectiveWorkspaceForPreflight(workspace, latest, mode).workspace;
      if (workspaceDependencySignature(effective, defaultShell) !== workspaceDependencySignature(latestEffective, defaultShell)) {
        continue;
      }
      if (missing.missingDirectories.length > 0) {
        setAppNotice(`Workspace not opened. Missing director${missing.missingDirectories.length === 1 ? "y" : "ies"}: ${missing.missingDirectories.join(", ")}`);
        return;
      }
      if (missing.missingShells.length > 0) {
        setAppNotice(`Workspace not opened. Missing shell presets: ${missing.missingShells.join(", ")}`);
        return;
      }
      current = latest;
      break;
    }
    if (!current) {
      setAppNotice("Workspace not opened because active sessions kept changing during preflight. Try again.");
      return;
    }
    const result = materializeWorkspace(workspace, current, { mode, availability: launchAvailability });
    if (!result.ok) {
      setAppNotice(describePlanIssues(result.issues));
      return;
    }
    applyWindowState(result.value.state);
    const skipped = result.value.skippedEntries.length;
    setAppNotice(skipped > 0
      ? `Workspace opened; skipped ${skipped} duplicate session entr${skipped === 1 ? "y" : "ies"}.`
      : `Workspace ${mode === "merge" ? "merged" : "replaced"}.`);
  }, [applyWindowState, defaultShell, launchAvailability, validateWorkspaceDependencies, workspaces]);

  const handleSaveRecipe = useCallback((recipe: LaunchRecipeV1): string | null => {
    const decoded = decodeLaunchRecipe(recipe);
    if (!decoded.ok) return describePlanIssues(decoded.issues);
    setLaunchRecipes(previous => {
      const index = previous.findIndex(candidate => candidate.id === decoded.value.id);
      if (index < 0) return [...previous, decoded.value];
      const next = [...previous];
      next[index] = decoded.value;
      return next;
    });
    return null;
  }, []);

  const handleDeleteRecipe = useCallback((id: string) => {
    setLaunchRecipes(previous => previous.filter(recipe => recipe.id !== id));
  }, []);

  const handleRunRecipe = useCallback(async (id: string) => {
    const recipe = launchRecipes.find(candidate => candidate.id === id);
    if (!recipe) {
      setAppNotice("That launch recipe no longer exists.");
      return;
    }
    const operation = ++planOperationRef.current;
    const context = { ...launchAvailability, ...(contextProject?.path ? { projectPath: contextProject.path } : {}) };
    const preflight = preflightLaunchRecipe(recipe, context);
    if (!preflight.ok) {
      setAppNotice(describePlanIssues(preflight.issues));
      return;
    }
    try {
      const missing = await validateWorkspaceDependencies(preflight.value);
      if (operation !== planOperationRef.current) return;
      if (missing.missingDirectories.length > 0) {
        setAppNotice(`Recipe not run. Missing director${missing.missingDirectories.length === 1 ? "y" : "ies"}: ${missing.missingDirectories.join(", ")}`);
        return;
      }
      if (missing.missingShells.length > 0) {
        setAppNotice(`Recipe not run. Missing shell presets: ${missing.missingShells.join(", ")}`);
        return;
      }
    } catch (error) {
      if (operation === planOperationRef.current) setAppNotice(`Recipe preflight failed: ${String(error)}`);
      return;
    }
    const current = createWindowState(tabsRef.current, groupsRef.current, activeTabIdRef.current, activeLeafByGroupRef.current);
    const result = materializeLaunchRecipe(recipe, current, { context });
    if (!result.ok) {
      setAppNotice(describePlanIssues(result.issues));
      return;
    }
    applyWindowState(result.value.state);
    setAppNotice(`Recipe '${recipe.name}' started.`);
  }, [applyWindowState, contextProject?.path, launchAvailability, launchRecipes, validateWorkspaceDependencies]);

  const handleNewChatInActive = useCallback((agent?: AgentId) => {
    if (contextProject) handleNewChat(contextProject, agent);
  }, [contextProject, handleNewChat]);

  // The + button in the tab bar: always open a raw shell using the user's default shell,
  // cwd = context project (or home if none).
  const handleNewShellInContext = useCallback(() => {
    const shell = getShellById(defaultShell);
    handleNewShell(contextProject, defaultShell, shell?.name || "Shell");
  }, [contextProject, defaultShell, handleNewShell]);

  // Group-aware tab selection: a tab inside a group requires activating its group AND
  // marking that pane as the focused leaf. Standalone tabs and groups themselves fall
  // through to a plain setActiveTabId. Used by both the tab bar and the search dialog.
  const handleSelectTab = useCallback((id: string) => {
    const tab = tabsRef.current.find(t => t.id === id);
    if (tab?.groupId) {
      setActiveTabId(tab.groupId);
      setActiveLeafByGroup(prev => ({ ...prev, [tab.groupId!]: id }));
    } else {
      setActiveTabId(id);
    }
  }, []);

  const handleRenameTab = useCallback((id: string, name: string) => {
    setTabs(prev => prev.map(tab => tab.id === id && tab.customTitle !== name ? { ...tab, customTitle: name } : tab));
  }, []);

  const handleTogglePin = useCallback((id: string) => {
    const group = groupsRef.current.find(candidate => candidate.id === id);
    if (group) {
      setGroups(prev => prev.map(candidate => candidate.id === id ? { ...candidate, pinned: !candidate.pinned } : candidate));
      return;
    }
    setTabs(prev => prev.map(tab => tab.id === id && !tab.groupId ? { ...tab, pinned: !tab.pinned } : tab));
  }, []);

  const handleSetInteractionSettings = useCallback((candidate: InteractionSettings): string | null => {
    const next = sanitizeInteractionSettings(candidate);
    const conflict = findInteractionSettingConflicts(next)[0];
    if (conflict) {
      return `This shortcut conflicts with ${conflict.firstId === conflict.secondId ? "another binding" : `${conflict.firstId} / ${conflict.secondId}`}.`;
    }
    setInteractionSettings(next);
    return null;
  }, []);

  return (
    <div className={`app-layout ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      {/* Boot splash — full-window, screen-centered, drawn above everything (incl. the sidebar)
          so it isn't offset by the layout while the app loads. */}
      {initialLoading && (
        <div className="app-loading-overlay">
          <div className="spinner" />
          <span>Loading...</span>
        </div>
      )}
      <TabBar tabs={tabs} entries={entries} onRenameTab={handleRenameTab} onRenameGroup={(id, name) => setGroups(prev => prev.map(g => g.id === id ? { ...g, name } : g))} onTogglePin={handleTogglePin} onReopenClosed={handleReopenClosed} closedCount={closedHistory.length} workspaces={workspaces} launchRecipes={launchRecipes} onSaveWorkspace={() => { setWorkspaceCaptureName(""); setWorkspaceCaptureOpen(true); }} onOpenWorkspace={(id, mode) => { void handleOpenWorkspace(id, mode); }} onRunRecipe={(id) => { void handleRunRecipe(id); }} activities={activities} interactionSettings={interactionSettings} closingTabIds={closingTabIds} activeTabId={activeTabId} selectedProject={selectedProject} hoveredProjectPath={hoveredProjectPath} linkedProjectPath={activeTabProjectPath} activeTabProject={contextProject} openSessionIds={new Set(tabs.filter(t => t.sessionId).map(t => t.sessionId!))} projectIcons={projectIcons} pinnedProjects={userProjects} sidebarCollapsed={sidebarCollapsed} defaultShell={defaultShell} installedAgents={installedAgents} updateAvailable={updateInfo.updateAvailable} onExpandSidebar={() => setSidebarCollapsed(false)} onSelectTab={handleSelectTab} onCloseTab={handleCloseTab} onReorderTabs={handleReorderTabs} onNewChat={handleNewChat} onNewChatInActive={handleNewChatInActive} onNewShellInContext={handleNewShellInContext} onOpenSession={handleOpenSession} onNewShell={handleNewShell} onGoHome={handleGoHome} onOpenSettings={() => setActiveTabId("settings")} onToggleSidebar={() => setSidebarCollapsed(c => !c)} />
      <div className="app-body">
      <Sidebar projects={userProjects} projectIcons={projectIcons} selectedProject={selectedProject} activeCountByProject={activeCountByProject} sidebarLayout={sidebarLayout} onLayoutChange={persistSidebarLayout} onSelectProject={handleSelectProject} onGoHome={handleGoHome} onRemoveProject={handleRemoveProject} onEditProject={(p) => setEditingProjectPath(p)} onHoverProject={setHoveredProjectPath} onOpenSettings={() => setActiveTabId("settings")} onAddProject={() => setShowProjectPicker(true)} onCollapse={() => setSidebarCollapsed(true)} activeTabId={activeTabId} linkedProjectPath={activeTabProjectPath} showRateLimit={showRateLimitInSidebar} showRateLimitCodex={showRateLimitInSidebarCodex} updateAvailable={updateInfo.updateAvailable} />
      <div className="main-content">
        {/* Settings view — hidden unless activeTabId === 'settings' */}
        <div style={{ display: showSettings ? "flex" : "none", flex: 1, overflow: "hidden" }}>
          <SettingsView theme={theme} onSetTheme={persistTheme} defaultAgent={defaultAgent} onSetDefaultAgent={persistDefaultAgent} gitLazyPolling={gitLazyPolling} onSetGitLazyPolling={persistGitLazyPolling} gitChangesTree={gitChangesTree} onSetGitChangesTree={persistGitChangesTree} fileExplorerOnStart={fileExplorerOnStart} onSetFileExplorerOnStart={persistFileExplorerOnStart} contextTreeEnabled={contextTreeEnabled} onSetContextTreeEnabled={persistContextTreeEnabled} terminalBgColor={terminalBgColor} onSetTerminalBgColor={persistTerminalBgColor} defaultTerminalFontSize={defaultTerminalFontSize} onSetDefaultTerminalFontSize={persistDefaultTerminalFontSize} alwaysOnTop={alwaysOnTop} onSetAlwaysOnTop={persistAlwaysOnTop} defaultShell={defaultShell} onSetDefaultShell={persistDefaultShell} fullscreenRendering={fullscreenRendering} onSetFullscreenRendering={persistFullscreenRendering} forceSyncOutput={forceSyncOutput} onSetForceSyncOutput={persistForceSyncOutput} webglRendering={webglRendering} onSetWebglRendering={persistWebglRendering} terminalFontWeight={terminalFontWeight} onSetTerminalFontWeight={persistTerminalFontWeight} eagerInitTabs={eagerInitTabs} onSetEagerInitTabs={persistEagerInitTabs} restoreUnpinnedTabs={restoreUnpinnedTabs} onSetRestoreUnpinnedTabs={setRestoreUnpinnedTabs} notificationPreferences={notificationPreferences} nativeNotificationPermission={nativeNotificationPermission} onSetNotificationPreferences={handleSetNotificationPreferences} onRequestNotificationPermission={handleRequestNotificationPermission} interactionSettings={interactionSettings} onSetInteractionSettings={handleSetInteractionSettings} showRateLimitInSidebar={showRateLimitInSidebar} onSetShowRateLimitInSidebar={persistShowRateLimitInSidebar} showSessionRowMetrics={showSessionRowMetrics} onSetShowSessionRowMetrics={persistShowSessionRowMetrics} showSessionRowMetricsCodex={showSessionRowMetricsCodex} onSetShowSessionRowMetricsCodex={persistShowSessionRowMetricsCodex} showSessionRowMetricsOpencode={showSessionRowMetricsOpencode} onSetShowSessionRowMetricsOpencode={persistShowSessionRowMetricsOpencode} showRateLimitInSidebarCodex={showRateLimitInSidebarCodex} onSetShowRateLimitInSidebarCodex={persistShowRateLimitInSidebarCodex} showTerminalHeaderStats={showTerminalHeaderStats} onSetShowTerminalHeaderStats={persistShowTerminalHeaderStats} showProjectStatsChart={showProjectStatsChart} onSetShowProjectStatsChart={persistShowProjectStatsChart} workspaces={workspaces} launchRecipes={launchRecipes} onCaptureWorkspace={handleCaptureWorkspace} onSaveWorkspace={handleSaveWorkspace} onDeleteWorkspace={handleDeleteWorkspace} onOpenWorkspace={handleOpenWorkspace} onSaveRecipe={handleSaveRecipe} onDeleteRecipe={handleDeleteRecipe} onRunRecipe={handleRunRecipe} updateInfo={updateInfo} />
        </div>
        {/* Home view — hidden when a terminal tab is active */}
        <div style={{ display: showHome ? "flex" : "none", flex: 1, overflow: "hidden" }}>
          <HomeView contextTreeEnabled={contextTreeEnabled} showSessionRowMetrics={showSessionRowMetrics} showSessionRowMetricsCodex={showSessionRowMetricsCodex} showSessionRowMetricsOpencode={showSessionRowMetricsOpencode} showProjectStatsChart={showProjectStatsChart} projects={userProjects} allProjects={allProjects} activeCountByProject={activeCountByProject} selectedProject={selectedProject} projectIcons={projectIcons} recentSessions={recentSessions} projectSessions={projectSessions} openSessionIds={new Set(tabs.filter(t => t.sessionId).map(t => t.sessionId!))} sessionGroupName={(() => {
            const map: Record<string, string> = {};
            for (const t of tabs) {
              if (t.sessionId && t.groupId) {
                const g = groups.find(gr => gr.id === t.groupId);
                if (g) map[t.sessionId] = g.name;
              }
            }
            return map;
          })()} loading={initialLoading} sessionsLoading={sessionsLoading} projectStatsView={projectStatsView} onChangeProjectStatsView={persistProjectStatsView} onOpenSession={handleOpenSession} onOpenSessionBackground={handleOpenSessionBackground} onSelectProject={handleSelectProject} onNewChat={handleNewChat} onAddProject={() => setShowProjectPicker(true)} onRemoveProject={handleRemoveProject} onEditProject={(p) => setEditingProjectPath(p)} onSaveFolders={handleSaveFolders} />
        </div>
        {/* Work area — shows the active entry (either a single tab or a group's split layout).
            Terminal DOM hosts (created imperatively below) are physically reparented into
            the relevant slots on each layout change; the TerminalTab React instance stays
            alive throughout, so its xterm + PTY are never re-spawned. */}
        <div ref={workAreaRef} className="work-area" style={{ display: showSettings || showHome ? "none" : "flex", flex: 1, overflow: "hidden", position: "relative" }}>
          {/* Standalone tabs render a bare slot (no React-level TerminalTab here). */}
          {tabs.filter(t => !t.groupId).map(tab => (
            <div key={tab.id} data-group-leaf={tab.id} className="work-pane" style={{ display: tab.id === activeTabId ? "flex" : "none" }}>
              <div className="terminal-slot" data-terminal-slot={tab.id} />
            </div>
          ))}
          {/* Group panes — the GroupView also renders slot divs for its leaves. */}
          {groups.map(g => {
            const isActive = g.id === activeTabId;
            const activeLeafId = activeLeafByGroup[g.id] || collectLeafIds(g.layout)[0] || null;
            return (
              <div key={g.id} className="work-pane" style={{ display: isActive ? "flex" : "none" }}>
                <GroupView
                  layout={g.layout}
                  activeLeafId={activeLeafId}
                  onFocusLeaf={(tabId) => setActiveLeafByGroup(prev => ({ ...prev, [g.id]: tabId }))}
                  onClosePane={closePaneInGroup}
                  onRatioChange={(path, ratio) => updateGroupRatio(g.id, path, ratio)}
                />
              </div>
            );
          })}
          {dragOver && dragOver.targetTabId && dragOver.zone && (
            <DropZoneOverlay targetTabId={dragOver.targetTabId} zone={dragOver.zone} />
          )}
        </div>

        {/* Floating drag ghost — a small pill with the dragged tab's label that follows the
            cursor while the user is dragging a tab into the work area. */}
        {dragOver && dragPos && (() => {
          const t = tabs.find(x => x.id === dragOver.tabId);
          if (!t) return null;
          const label = t.title || t.projectName || "Tab";
          return (
            <div className="tab-drag-ghost" style={{ top: dragPos.y + 12, left: dragPos.x + 14 }}>
              <span className="tab-drag-ghost-dot" />
              <span className="tab-drag-ghost-label">{label}</span>
              {t.projectName && <span className="tab-drag-ghost-sub">{t.projectName}</span>}
            </div>
          );
        })()}

        {/* Hidden parking area for terminal hosts that currently have no visible slot
            (inactive tabs, groups in the background). Keeps the React tree stable. */}
        <div ref={parkingRef} style={{ display: "none" }} aria-hidden />

        {/* Portal each TerminalTab into its stable DOM host. Because the host is a plain
            DOM node (not managed by React's child reconciliation for the work area),
            we can appendChild it into whichever slot corresponds to its current layout
            position without triggering an unmount — the xterm and PTY keep running. */}
        {tabs.map(tab => {
          const host = ensureHost(tab.id);
          // Look up the encoded claude-projects dir name for this tab's project so the
          // TerminalTab can pull cost/context stats. Empty string when the project hasn't
          // been seen by claude yet — TerminalTab handles that by hiding the stats strip.
          const encodedName = tab.projectPath
            ? (allProjects.find(p => p.path.toLowerCase() === tab.projectPath!.toLowerCase())?.encoded_name || "")
            : "";
          // The third arg is the portal's key — without it, this array reconciles by index,
          // so reordering tabs shuffles which host each portal targets and React remounts
          // the subtree (which kills the PTY in TerminalTab's cleanup). Keying by tab.id
          // makes a reorder a pure move — the TerminalTab instance, xterm, and PTY survive.
          return createPortal(
            <TerminalTab tab={tab} isActive={tab.id === activeTabId || (!!tab.groupId && tab.groupId === activeTabId && activeLeafByGroup[tab.groupId] === tab.id)} gitLazyPolling={gitLazyPolling} gitChangesTree={gitChangesTree} fileExplorerOnStart={fileExplorerOnStart} terminalBgColor={terminalBgColor} defaultFontSize={defaultTerminalFontSize} defaultShellId={defaultShell} fullscreenRendering={fullscreenRendering} forceSyncOutput={forceSyncOutput} webglRendering={webglRendering} terminalFontWeight={terminalFontWeight} eagerInit={eagerInitTabs} theme={theme} projectEncodedName={encodedName} showTerminalHeaderStats={showTerminalHeaderStats} interactionSettings={interactionSettings} onBranchSwitch={handleSwitchTabToBranch} onActivityEvent={handleActivityEvent} onCommandLaunchConfirmed={handleCommandLaunchConfirmed} />,
            host,
            tab.id,
          );
        })}
      </div>
      </div>
      {showProjectPicker && <ProjectPicker allProjects={allProjects} savedPaths={savedPaths} onToggle={handleToggleProject} onBrowse={() => { handleBrowseFolder(); setShowProjectPicker(false); }} onClose={() => setShowProjectPicker(false)} onRefresh={async () => { try { setAllProjects(await invoke<ProjectInfo[]>("list_claude_projects")); } catch (_) {} }} />}
      {workspaceCaptureOpen && (
        <div className="plan-editor-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setWorkspaceCaptureOpen(false); }}>
          <form className="workspace-name-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-name-title" onSubmit={event => {
            event.preventDefault();
            const error = handleCaptureWorkspace(workspaceCaptureName);
            if (error) {
              setAppNotice(error);
              return;
            }
            setWorkspaceCaptureOpen(false);
            setAppNotice(`Workspace '${workspaceCaptureName.trim()}' saved.`);
          }}>
            <div className="plan-editor-kicker">Current window snapshot</div>
            <h2 id="workspace-name-title">Save workspace</h2>
            <p>Preserves ordered tabs, groups, sessions, custom titles, pins, active panes, and split ratios.</p>
            <input value={workspaceCaptureName} onChange={event => setWorkspaceCaptureName(event.target.value)} placeholder="Workspace name" autoFocus />
            <div className="plan-editor-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setWorkspaceCaptureOpen(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={!workspaceCaptureName.trim()}>Save snapshot</button>
            </div>
          </form>
        </div>
      )}
      {appNotice && <div className="app-notice" role="status"><AlertTriangle size={14} /><span>{appNotice}</span><button type="button" onClick={() => setAppNotice(null)} aria-label="Dismiss"><XIcon size={13} /></button></div>}
      {agentPickerProject && <AgentPickerDialog project={agentPickerProject} agents={AGENT_IDS.filter(a => installedAgents[a])} onPick={(agent) => { const p = agentPickerProject; setAgentPickerProject(null); handleNewChat(p, agent); }} onClose={() => setAgentPickerProject(null)} onOpenSettings={() => { setAgentPickerProject(null); setActiveTabId("settings"); }} />}
      {editingProjectPath && (() => {
        const proj = allProjects.find(p => p.path.toLowerCase() === editingProjectPath.toLowerCase()) || userProjects.find(p => p.path.toLowerCase() === editingProjectPath.toLowerCase());
        if (!proj) { setEditingProjectPath(null); return null; }
        const settings = projectIcons[editingProjectPath.toLowerCase()] || {};
        return <ProjectEditorDialog project={proj} settings={settings} onSave={(s) => handleSaveProjectSettings(editingProjectPath, s)} onClose={() => setEditingProjectPath(null)} />;
      })()}
      {updateDialogOpen && <UpdateDialog info={updateInfo} onDismiss={dismissUpdateDialog} />}
    </div>
  );
}
