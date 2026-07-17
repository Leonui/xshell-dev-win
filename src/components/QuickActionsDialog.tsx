import { useEffect, useMemo, useRef, useState } from "react";
import { Search, Terminal as TerminalIcon, Settings, X, PanelLeft, ChevronRight, ChevronLeft, Bot, RotateCcw, Save, Layers3, Play } from "lucide-react";
import { useProjectImage } from "../hooks/useProjectImage";
import { ShellIcon } from "./ShellIcon";
import { AGENT_IDS, AgentIcon, type AgentId } from "../agents";
import { getAvailableShells } from "../shells";
import logo from "../assets/logo.png";
import type { ProjectInfo, ProjectSettings, Tab } from "../types";
import type { LaunchRecipeV1, WorkspaceV1 } from "../lib/launchPlans";

// Local icon adapter: lets us slot the xshell logo into the same `icon` prop slot as the
// lucide icons used by other action rows. Matches the sidebar's home-button branding.
// Forces a slightly larger render than the standard 14px lucide glyphs so the logo's
// detail reads — the action-row tile (26px) is already big enough to host it.
function XShellHomeIcon({ className }: { size?: number; className?: string }) {
  return <img src={logo} width={20} height={20} className={className} alt="" draggable={false} style={{ borderRadius: "50%", objectFit: "cover" }} />;
}

interface QuickActionsDialogProps {
  tabs: Tab[];
  activeTabId: string;
  projectIcons: Record<string, ProjectSettings>;
  pinnedProjects: ProjectInfo[];
  contextProject: ProjectInfo | null;
  hoveredProjectPath: string | null;
  linkedProjectPath: string | null;
  selectedProjectPath: string | null;
  hasActiveTab: boolean;
  closedCount: number;
  workspaces: WorkspaceV1[];
  launchRecipes: LaunchRecipeV1[];
  installedAgents: Record<AgentId, boolean>;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onReopenClosed: () => void;
  onSaveWorkspace: () => void;
  onOpenWorkspace: (id: string, mode: "merge" | "replace") => void;
  onRunRecipe: (id: string) => void;
  onNewChat: (project: ProjectInfo) => void;
  onNewShell: (project: ProjectInfo | null, shellId: string, shellName: string) => void;
  onGoHome: () => void;
  onOpenSettings: () => void;
  onToggleSidebar: () => void;
  onClose: () => void;
}

// Tab-style segmented row at the top: Tabs | Actions, navigable with ←/→.
// "new-chat-project" and "new-shell" are drill-down views; ← (or Backspace on empty
// query) pops them back to "actions". The shell drill-down opens in the current
// context project (the active tab's project, or ~ if there isn't one).
type View = "tabs" | "actions" | "new-chat-project" | "new-shell" | "open-workspace" | "run-recipe";

function getInitials(name: string): string {
  const parts = name.replace(/[^a-zA-Z0-9\s\-_.]/g, "").split(/[\s\-_.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function ProjectMiniIcon({ iconValue, color, name }: { iconValue?: string; color?: string; name: string }) {
  const imgSrc = useProjectImage(iconValue);
  if (imgSrc) return <div className="ts-project-icon"><img src={imgSrc} className="ts-project-img" alt="" /></div>;
  return <div className="ts-project-icon" style={{ background: color || undefined }}>{iconValue || getInitials(name || "?")}</div>;
}

export function QuickActionsDialog({ tabs, activeTabId, projectIcons, pinnedProjects, contextProject, hoveredProjectPath, linkedProjectPath, selectedProjectPath, hasActiveTab, closedCount, workspaces, launchRecipes, installedAgents, onSelectTab, onCloseTab, onReopenClosed, onSaveWorkspace, onOpenWorkspace, onRunRecipe, onNewChat, onNewShell, onGoHome, onOpenSettings, onToggleSidebar, onClose }: QuickActionsDialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Default to the Actions view when there are no tabs to switch between — otherwise
  // the user lands on an empty list with a "No active tabs" message.
  const [view, setView] = useState<View>(tabs.length === 0 ? "actions" : "tabs");
  const [query, setQuery] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(0);

  // Hover guard: ignore onMouseEnter until the cursor *actually* moves. Without this,
  // opening the dialog under a stationary cursor immediately steals the highlight away
  // from index 0; keyboard nav also slides rows under the cursor and triggers spurious
  // hover events. We re-arm on every keydown nav so the same scroll-under-cursor case
  // doesn't bite mid-session.
  const mouseActiveRef = useRef(false);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const last = lastPosRef.current;
      if (last && (last.x !== e.clientX || last.y !== e.clientY)) mouseActiveRef.current = true;
      lastPosRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);
  const handleHover = (i: number) => { if (mouseActiveRef.current) setHighlightIdx(i); };

  // Sort: claude tabs first by lastActiveAt desc, then raw shells by lastActiveAt desc.
  const sortedTabs = useMemo(() => {
    const score = (t: Tab) => t.lastActiveAt ?? 0;
    const claude = tabs.filter(t => t.shellMode !== "raw").sort((a, b) => score(b) - score(a));
    const raw = tabs.filter(t => t.shellMode === "raw").sort((a, b) => score(b) - score(a));
    return [...claude, ...raw];
  }, [tabs]);

  // Filter tabs by query.
  const filteredTabs = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sortedTabs;
    return sortedTabs.filter(t => {
      const customName = t.projectPath ? projectIcons[t.projectPath.toLowerCase()]?.customName : undefined;
      const projDisplayName = customName || t.projectName || "";
      const haystack = `${t.customTitle || ""} ${t.title} ${projDisplayName} ${t.shellId || ""}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [sortedTabs, query, projectIcons]);

  // Project-context label used in the "New shell in <here>" hint.
  const contextLabel = contextProject ? (projectIcons[contextProject.path.toLowerCase()]?.customName || contextProject.name) : "~";

  // Icon for the new-chat affordances: the single installed agent's mark, or a neutral
  // agent glyph when several are installed — which agent hosts the chat is resolved after
  // the project pick (default agent or the chooser dialog), so no specific mark is honest.
  const installed = AGENT_IDS.filter(id => installedAgents[id]);
  const newChatAgent: AgentId | null = installed.length === 1 ? installed[0] : null;
  const NewChatIcon = ({ size, className }: { size?: number; className?: string }) =>
    newChatAgent ? <AgentIcon agent={newChatAgent} size={size} className={className} /> : <Bot size={size} className={className} />;

  // Action list — filtered by query. `disabled` actions still render but can't be activated.
  type Action = { id: string; label: string; icon: React.ComponentType<{ size?: number; className?: string }>; hint?: string; drill?: View; run?: () => void; disabled?: boolean };
  const actions: Action[] = useMemo(() => [
    { id: "new-chat", label: "New chat in...", icon: NewChatIcon, hint: "pick a project", drill: "new-chat-project" },
    { id: "new-shell", label: "New shell in...", icon: TerminalIcon, hint: `pick a shell · opens in ${contextLabel}`, drill: "new-shell" },
    { id: "save-workspace", label: "Save workspace", icon: Save, hint: "snapshot this window", run: onSaveWorkspace, disabled: tabs.length === 0 },
    { id: "open-workspace", label: "Open workspace", icon: Layers3, hint: workspaces.length > 0 ? `${workspaces.length} saved` : "no saved workspaces", drill: "open-workspace", disabled: workspaces.length === 0 },
    { id: "run-recipe", label: "Run recipe", icon: Play, hint: launchRecipes.length > 0 ? `${launchRecipes.length} available` : "no launch recipes", drill: "run-recipe", disabled: launchRecipes.length === 0 },
    { id: "reopen-closed", label: "Reopen closed", icon: RotateCcw, hint: closedCount > 0 ? `${closedCount} item${closedCount === 1 ? "" : "s"} available` : "nothing closed this session", run: onReopenClosed, disabled: closedCount === 0 },
    { id: "close-tab", label: "Close active tab", icon: X, run: () => { if (hasActiveTab) onCloseTab(activeTabId); }, disabled: !hasActiveTab },
    { id: "go-home", label: "Go home", icon: XShellHomeIcon, run: onGoHome },
    { id: "toggle-sidebar", label: "Toggle sidebar", icon: PanelLeft, run: onToggleSidebar },
    { id: "open-settings", label: "Open settings", icon: Settings, run: onOpenSettings },
  // newChatAgent dep: NewChatIcon is recreated per render but only its agent matters —
  // re-memo when the detection probe changes which agents are installed.
  ], [hasActiveTab, activeTabId, closedCount, contextLabel, launchRecipes.length, newChatAgent, onCloseTab, onReopenClosed, onSaveWorkspace, onGoHome, onToggleSidebar, onOpenSettings, tabs.length, workspaces.length]);

  // Available shells for the drill-down view.
  const shells = useMemo(() => getAvailableShells(), []);

  const filteredShells = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return shells;
    return shells.filter(s => `${s.name} ${s.id} ${s.command}`.toLowerCase().includes(q));
  }, [shells, query]);

  const filteredActions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter(a => `${a.label} ${a.hint || ""}`.toLowerCase().includes(q));
  }, [actions, query]);

  // Drill-down view: list of pinned projects.
  const filteredProjects = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return pinnedProjects;
    return pinnedProjects.filter(p => {
      const settings = projectIcons[p.path.toLowerCase()];
      const display = settings?.customName || p.name;
      return `${display} ${p.path}`.toLowerCase().includes(q);
    });
  }, [pinnedProjects, query, projectIcons]);

  const filteredWorkspaces = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return workspaces;
    return workspaces.filter(workspace => workspace.name.toLowerCase().includes(q));
  }, [query, workspaces]);

  const filteredRecipes = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return launchRecipes;
    return launchRecipes.filter(recipe => `${recipe.name} ${recipe.description || ""} ${recipe.projectPath || ""}`.toLowerCase().includes(q));
  }, [launchRecipes, query]);

  // Currently visible list — drives keyboard navigation and how many rows the dialog shows.
  const listLength =
    view === "tabs" ? filteredTabs.length :
    view === "actions" ? filteredActions.length :
    view === "new-chat-project" ? filteredProjects.length :
    view === "new-shell" ? filteredShells.length :
    view === "open-workspace" ? filteredWorkspaces.length :
    filteredRecipes.length;

  // Reset highlight + clear query when view changes; reset highlight as result set shrinks.
  useEffect(() => { setHighlightIdx(0); setQuery(""); }, [view]);
  useEffect(() => { setHighlightIdx(0); }, [query]);
  useEffect(() => { if (highlightIdx >= listLength && listLength > 0) setHighlightIdx(0); }, [listLength, highlightIdx]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Outside-click + key handling. ←/→ swap top-level views; ← also pops the drill-down.
  // Backspace on an empty query while drilled-down behaves like ← (mimics Raycast/Spotlight).
  useEffect(() => {
    const handlePointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); mouseActiveRef.current = false; setHighlightIdx(i => Math.min(i + 1, Math.max(0, listLength - 1))); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); mouseActiveRef.current = false; setHighlightIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === "ArrowRight") {
        if (view === "tabs") { e.preventDefault(); setView("actions"); }
        return;
      }
      if (e.key === "ArrowLeft") {
        if (view === "actions") { e.preventDefault(); setView("tabs"); }
        else if (view !== "tabs") { e.preventDefault(); setView("actions"); }
        return;
      }
      if (e.key === "Backspace" && query === "" && view !== "tabs" && view !== "actions") { e.preventDefault(); setView("actions"); return; }
      if (e.key === "Enter") {
        e.preventDefault();
        if (view === "tabs") {
          const pick = filteredTabs[highlightIdx];
          if (pick) { onSelectTab(pick.id); onClose(); }
        } else if (view === "actions") {
          const pick = filteredActions[highlightIdx];
          if (!pick || pick.disabled) return;
          if (pick.drill) setView(pick.drill);
          else { pick.run?.(); onClose(); }
        } else if (view === "new-chat-project") {
          const pick = filteredProjects[highlightIdx];
          if (pick) { onNewChat(pick); onClose(); }
        } else if (view === "new-shell") {
          const pick = filteredShells[highlightIdx];
          if (pick) { onNewShell(contextProject, pick.id, pick.name); onClose(); }
        } else if (view === "open-workspace") {
          const pick = filteredWorkspaces[highlightIdx];
          if (pick) { onOpenWorkspace(pick.id, e.shiftKey ? "replace" : "merge"); onClose(); }
        } else {
          const pick = filteredRecipes[highlightIdx];
          if (pick) { onRunRecipe(pick.id); onClose(); }
        }
      }
    };
    document.addEventListener("pointerdown", handlePointer, true);
    document.addEventListener("keydown", handleKey);
    return () => { document.removeEventListener("pointerdown", handlePointer, true); document.removeEventListener("keydown", handleKey); };
  }, [onClose, listLength, view, query, filteredTabs, filteredActions, filteredProjects, filteredShells, filteredWorkspaces, filteredRecipes, highlightIdx, onSelectTab, onNewChat, onNewShell, onOpenWorkspace, onRunRecipe, contextProject]);

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-ts-idx="${highlightIdx}"]`) as HTMLElement | null;
    el?.scrollIntoView?.({ block: "nearest" });
  }, [highlightIdx]);

  const highlightPath = (hoveredProjectPath || linkedProjectPath || selectedProjectPath || "").toLowerCase();

  // Placeholder copy is mode-aware so it's always obvious what the input filters.
  const placeholder =
    view === "tabs" ? "Search active tabs..." :
    view === "actions" ? "Search actions..." :
    view === "new-chat-project" ? "Pick a project..." :
    view === "new-shell" ? "Pick a shell..." :
    view === "open-workspace" ? "Open a workspace..." :
    "Run a recipe...";

  // Section divider between claude tabs and raw shells in the Tabs view.
  const firstRawIdx = view === "tabs" ? filteredTabs.findIndex(t => t.shellMode === "raw") : -1;

  return (
    <div className="ts-overlay">
      <div className="ts-dialog" ref={ref} role="dialog" aria-modal="true" aria-label="Quick Actions">
        {/* Segmented pill row — the user's mental model is a pair of tabs that ←/→ swap between. */}
        <div className="ts-views">
          <button className={`ts-view-pill ${view === "tabs" ? "active" : ""}`} onClick={() => setView("tabs")}>Tabs <span className="ts-view-count">{tabs.length}</span></button>
          <button className={`ts-view-pill ${view !== "tabs" ? "active" : ""}`} onClick={() => setView("actions")}>Actions</button>
          <div className="ts-views-spacer" />
          <span className="ts-arrow-hint"><ChevronLeft size={10} /><ChevronRight size={10} /></span>
        </div>

        <div className="ts-search-row">
          <Search size={14} className="ts-search-icon" />
          <input ref={inputRef} className="ts-search-input" placeholder={placeholder} value={query} onChange={(e) => setQuery(e.target.value)} />
          {(view !== "tabs" && view !== "actions") && (
            <span className="ts-breadcrumb">
              <ChevronLeft size={10} /> back: ←
            </span>
          )}
          <span className="ts-count">{listLength}</span>
        </div>

        <div className="ts-list" ref={listRef}>
          {/* ── Tabs view ──────────────────────────────────────── */}
          {view === "tabs" && filteredTabs.length === 0 && (
            <div className="ts-empty">{tabs.length === 0 ? "No active tabs" : "No tabs match your search"}</div>
          )}
          {view === "tabs" && filteredTabs.map((tab, i) => {
            const isHighlighted = i === highlightIdx;
            const isActive = tab.id === activeTabId;
            const settings = tab.projectPath ? projectIcons[tab.projectPath.toLowerCase()] : undefined;
            const customName = settings?.customName;
            const projDisplayName = customName || tab.projectName || (tab.projectPath ? "" : "~");
            const isRawShell = tab.shellMode === "raw";
            const defaultTitle = isRawShell ? (projDisplayName || tab.title) : tab.title;
            const displayTitle = tab.customTitle || defaultTitle;
            const displaySubtitle = tab.customTitle ? "" : (isRawShell ? tab.title : projDisplayName);
            const matches = !!highlightPath && tab.projectPath && tab.projectPath.toLowerCase() === highlightPath;
            const showDivider = i > 0 && i === firstRawIdx;
            return (
              <div key={tab.id}>
                {showDivider && <div className="ts-section-divider"><span>Raw shells</span></div>}
                <div data-ts-idx={i} className={`ts-row ${isHighlighted ? "highlighted" : ""} ${isActive ? "active" : ""}`} onMouseEnter={() => handleHover(i)} onClick={() => { onSelectTab(tab.id); onClose(); }}>
                  {isRawShell
                    ? <div className="ts-project-icon ts-shell-slot"><ShellIcon id={tab.shellId} size={16} /></div>
                    : <ProjectMiniIcon iconValue={settings?.icon} color={settings?.color} name={projDisplayName || "?"} />}
                  <div className="ts-row-text">
                    <div className="ts-row-title">{displayTitle}</div>
                    {displaySubtitle && <div className="ts-row-sub">{displaySubtitle}</div>}
                  </div>
                  {isRawShell
                    ? <TerminalIcon size={11} className="ts-row-tag-icon" />
                    : <span className={`ts-row-dot ${matches ? "ts-row-dot-active" : ""}`} />}
                </div>
              </div>
            );
          })}

          {/* ── Actions view ───────────────────────────────────── */}
          {view === "actions" && filteredActions.length === 0 && (
            <div className="ts-empty">No actions match</div>
          )}
          {view === "actions" && filteredActions.map((action, i) => {
            const Icon = action.icon;
            const isHighlighted = i === highlightIdx;
            return (
              <div
                key={action.id}
                data-ts-idx={i}
                className={`ts-row ts-action-row ${isHighlighted ? "highlighted" : ""} ${action.disabled ? "disabled" : ""}`}
                onMouseEnter={() => handleHover(i)}
                onClick={() => {
                  if (action.disabled) return;
                  if (action.drill) setView(action.drill);
                  else { action.run?.(); onClose(); }
                }}
              >
                <div className="ts-action-icon"><Icon size={14} /></div>
                <div className="ts-row-text">
                  <div className="ts-row-title">{action.label}</div>
                  {action.hint && <div className="ts-row-sub">{action.hint}</div>}
                </div>
                {action.drill && <ChevronRight size={12} className="ts-row-tag-icon" />}
              </div>
            );
          })}

          {/* ── New-chat project picker ───────────────────────── */}
          {view === "new-chat-project" && pinnedProjects.length === 0 && (
            <div className="ts-empty">No pinned projects in the sidebar yet</div>
          )}
          {view === "new-chat-project" && filteredProjects.length === 0 && pinnedProjects.length > 0 && (
            <div className="ts-empty">No projects match your search</div>
          )}
          {view === "new-chat-project" && filteredProjects.map((proj, i) => {
            const isHighlighted = i === highlightIdx;
            const settings = projectIcons[proj.path.toLowerCase()];
            const display = settings?.customName || proj.name;
            return (
              <div
                key={proj.path}
                data-ts-idx={i}
                className={`ts-row ${isHighlighted ? "highlighted" : ""}`}
                onMouseEnter={() => handleHover(i)}
                onClick={() => { onNewChat(proj); onClose(); }}
              >
                <ProjectMiniIcon iconValue={settings?.icon} color={settings?.color} name={display} />
                <div className="ts-row-text">
                  <div className="ts-row-title">{display}</div>
                  <div className="ts-row-sub">{proj.path}</div>
                </div>
                <NewChatIcon size={13} className="ts-row-tag-icon" />
              </div>
            );
          })}

          {/* ── New-shell shell picker ────────────────────────── */}
          {view === "new-shell" && filteredShells.length === 0 && (
            <div className="ts-empty">No shells available on this platform</div>
          )}
          {view === "new-shell" && filteredShells.map((sh, i) => {
            const isHighlighted = i === highlightIdx;
            return (
              <div
                key={sh.id}
                data-ts-idx={i}
                className={`ts-row ${isHighlighted ? "highlighted" : ""}`}
                onMouseEnter={() => handleHover(i)}
                onClick={() => { onNewShell(contextProject, sh.id, sh.name); onClose(); }}
              >
                <div className="ts-project-icon ts-shell-slot"><ShellIcon id={sh.id} size={16} /></div>
                <div className="ts-row-text">
                  <div className="ts-row-title">{sh.name}</div>
                  <div className="ts-row-sub">opens in {contextLabel}</div>
                </div>
                <TerminalIcon size={11} className="ts-row-tag-icon" />
              </div>
            );
          })}

          {/* ── Saved workspace picker ───────────────────────── */}
          {view === "open-workspace" && filteredWorkspaces.length === 0 && (
            <div className="ts-empty">No workspaces match your search</div>
          )}
          {view === "open-workspace" && filteredWorkspaces.map((workspace, i) => {
            const isHighlighted = i === highlightIdx;
            const terminalCount = workspace.entries.reduce((total, entry) => total + (entry.kind === "tab" ? 1 : entry.tabs.length), 0);
            return (
              <div
                key={workspace.id}
                data-ts-idx={i}
                className={`ts-row ${isHighlighted ? "highlighted" : ""}`}
                onMouseEnter={() => handleHover(i)}
                onClick={() => { onOpenWorkspace(workspace.id, "merge"); onClose(); }}
              >
                <div className="ts-action-icon"><Layers3 size={14} /></div>
                <div className="ts-row-text">
                  <div className="ts-row-title">{workspace.name}</div>
                  <div className="ts-row-sub">{workspace.entries.length} entries / {terminalCount} terminals / Enter merges, Shift+Enter replaces</div>
                </div>
                <button type="button" className="ts-row-secondary" onClick={event => { event.stopPropagation(); onOpenWorkspace(workspace.id, "replace"); onClose(); }}>Replace</button>
              </div>
            );
          })}

          {/* ── Launch recipe picker ─────────────────────────── */}
          {view === "run-recipe" && filteredRecipes.length === 0 && (
            <div className="ts-empty">No recipes match your search</div>
          )}
          {view === "run-recipe" && filteredRecipes.map((recipe, i) => {
            const isHighlighted = i === highlightIdx;
            const stepCount = recipe.entries.reduce((total, entry) => total + (entry.kind === "tab" ? 1 : entry.tabs.length), 0);
            return (
              <div
                key={recipe.id}
                data-ts-idx={i}
                className={`ts-row ${isHighlighted ? "highlighted" : ""}`}
                onMouseEnter={() => handleHover(i)}
                onClick={() => { onRunRecipe(recipe.id); onClose(); }}
              >
                <div className="ts-action-icon"><Play size={14} /></div>
                <div className="ts-row-text">
                  <div className="ts-row-title">{recipe.name}</div>
                  <div className="ts-row-sub">{recipe.description || `${stepCount} preflighted step${stepCount === 1 ? "" : "s"}`}</div>
                </div>
                <Play size={11} className="ts-row-tag-icon" />
              </div>
            );
          })}
        </div>

        <div className="ts-hint-text">Supports keyboard navigation</div>
      </div>
    </div>
  );
}
