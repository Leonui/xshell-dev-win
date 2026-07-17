import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  Check,
  Copy,
  Layers3,
  Merge,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import type { AgentId } from "../agents";
import {
  LAUNCH_RECIPE_VERSION,
  validateLaunchRecipe,
  type LaunchRecipeV1,
  type RecipeEntryV1,
  type WorkspaceV1,
} from "../lib/launchPlans";

interface WorkspaceRecipeSettingsProps {
  workspaces: WorkspaceV1[];
  recipes: LaunchRecipeV1[];
  defaultShell: string;
  defaultAgent: AgentId;
  onCaptureWorkspace: (name: string) => string | null;
  onSaveWorkspace: (workspace: WorkspaceV1) => string | null;
  onDeleteWorkspace: (id: string) => void;
  onOpenWorkspace: (id: string, mode: "merge" | "replace") => Promise<void>;
  onSaveRecipe: (recipe: LaunchRecipeV1) => string | null;
  onDeleteRecipe: (id: string) => void;
  onRunRecipe: (id: string) => Promise<void>;
}

interface RecipeEditorProps {
  recipe: LaunchRecipeV1;
  defaultShell: string;
  defaultAgent: AgentId;
  onSave: (recipe: LaunchRecipeV1) => string | null;
  onClose: () => void;
}

function planCount(entries: readonly RecipeEntryV1[]): number {
  return entries.reduce((total, entry) => total + (entry.kind === "tab" ? 1 : entry.tabs.length), 0);
}

function workspaceTabCount(workspace: WorkspaceV1): number {
  return workspace.entries.reduce((total, entry) => total + (entry.kind === "tab" ? 1 : entry.tabs.length), 0);
}

function makeRecipe(defaultShell: string): LaunchRecipeV1 {
  const now = Date.now();
  return {
    version: LAUNCH_RECIPE_VERSION,
    id: crypto.randomUUID(),
    name: "New recipe",
    description: "",
    createdAt: now,
    updatedAt: now,
    entries: [{
      kind: "tab",
      tab: {
        key: "shell-1",
        title: "Shell",
        cwd: { kind: "home" },
        launch: { kind: "shell", shellId: defaultShell },
      },
    }],
    activeEntryKey: "shell-1",
  };
}

function parseEntries(source: string): { entries: RecipeEntryV1[]; error: string | null } {
  try {
    const value: unknown = JSON.parse(source);
    if (!Array.isArray(value)) return { entries: [], error: "Entries must be a JSON array." };
    return { entries: value as RecipeEntryV1[], error: null };
  } catch (error) {
    return { entries: [], error: `Invalid JSON: ${String(error)}` };
  }
}

function RecipeEditor({ recipe, defaultShell, defaultAgent, onSave, onClose }: RecipeEditorProps) {
  const [name, setName] = useState(recipe.name);
  const [description, setDescription] = useState(recipe.description || "");
  const [projectPath, setProjectPath] = useState(recipe.projectPath || "");
  const [activeEntryKey, setActiveEntryKey] = useState(recipe.activeEntryKey || "");
  const [entriesSource, setEntriesSource] = useState(() => JSON.stringify(recipe.entries, null, 2));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const appendTemplate = (kind: "agent" | "shell" | "command") => {
    const parsed = parseEntries(entriesSource);
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    const suffix = parsed.entries.reduce((total, entry) => total + (entry.kind === "tab" ? 1 : entry.tabs.length), 0) + 1;
    const key = `${kind}-${suffix}`;
    const launch = kind === "agent"
      ? { kind: "agent" as const, agent: defaultAgent, hostShellId: defaultShell }
      : kind === "shell"
        ? { kind: "shell" as const, shellId: defaultShell }
        : {
            kind: "command" as const,
            shellId: defaultShell,
            command: { kind: "argv" as const, program: "npm", args: ["test"] },
            env: {},
            keepOpen: true,
          };
    const next: RecipeEntryV1[] = [...parsed.entries, {
      kind: "tab",
      tab: {
        key,
        title: kind === "agent" ? "Agent" : kind === "shell" ? "Shell" : "Command",
        cwd: kind === "command" ? { kind: "project" } : { kind: "home" },
        launch,
      },
    }];
    setEntriesSource(JSON.stringify(next, null, 2));
    setError(null);
  };

  const formatEntries = () => {
    const parsed = parseEntries(entriesSource);
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    setEntriesSource(JSON.stringify(parsed.entries, null, 2));
    setError(null);
  };

  const save = () => {
    const parsed = parseEntries(entriesSource);
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    const candidate: LaunchRecipeV1 = {
      ...recipe,
      version: LAUNCH_RECIPE_VERSION,
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : { description: undefined }),
      ...(projectPath.trim() ? { projectPath: projectPath.trim() } : { projectPath: undefined }),
      entries: parsed.entries,
      ...(activeEntryKey.trim() ? { activeEntryKey: activeEntryKey.trim() } : { activeEntryKey: undefined }),
      updatedAt: Date.now(),
    };
    const issues = validateLaunchRecipe(candidate);
    if (issues.length > 0) {
      setError(issues.slice(0, 3).map(issue => `${issue.path}: ${issue.message}`).join(" "));
      return;
    }
    const saveError = onSave(candidate);
    if (saveError) {
      setError(saveError);
      return;
    }
    onClose();
  };

  return createPortal(
    <div className="plan-editor-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="plan-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="recipe-editor-title">
        <div className="plan-editor-head">
          <div>
            <div className="plan-editor-kicker">Versioned launch plan</div>
            <h2 id="recipe-editor-title">Edit recipe</h2>
          </div>
          <button type="button" className="plan-icon-button" onClick={onClose} aria-label="Close recipe editor"><X size={15} /></button>
        </div>

        <div className="plan-editor-fields">
          <label className="plan-field plan-field-wide">
            <span>Name</span>
            <input value={name} onChange={event => setName(event.target.value)} autoFocus />
          </label>
          <label className="plan-field plan-field-wide">
            <span>Description</span>
            <input value={description} onChange={event => setDescription(event.target.value)} placeholder="What this setup starts" />
          </label>
          <label className="plan-field">
            <span>Default project path</span>
            <input value={projectPath} onChange={event => setProjectPath(event.target.value)} placeholder="Optional; used by project cwd" />
          </label>
          <label className="plan-field">
            <span>Active entry key</span>
            <input value={activeEntryKey} onChange={event => setActiveEntryKey(event.target.value)} placeholder="Optional" />
          </label>
        </div>

        <div className="plan-editor-entries-head">
          <div>
            <strong>Ordered entries</strong>
            <span>Tabs and split groups use snapshot-local keys. Commands are structured and preflighted before launch.</span>
          </div>
          <div className="plan-template-buttons">
            <button type="button" onClick={() => appendTemplate("agent")}><Plus size={11} /> Agent</button>
            <button type="button" onClick={() => appendTemplate("shell")}><Plus size={11} /> Shell</button>
            <button type="button" onClick={() => appendTemplate("command")}><Plus size={11} /> Command</button>
            <button type="button" onClick={formatEntries}><RefreshCw size={11} /> Format</button>
          </div>
        </div>
        <textarea
          className="plan-json-editor"
          value={entriesSource}
          onChange={event => setEntriesSource(event.target.value)}
          spellCheck={false}
          aria-label="Recipe entries JSON"
        />
        <div className="plan-editor-hint">
          Cwd: <code>{`{"kind":"project"}`}</code>, <code>{`{"kind":"home"}`}</code>, or <code>{`{"kind":"absolute","path":"C:\\\\repo"}`}</code>. Split groups require 2-8 tabs and a matching binary layout tree.
        </div>
        {error && <div className="plan-editor-error" role="alert"><AlertTriangle size={13} /> {error}</div>}
        <div className="plan-editor-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save}><Check size={12} /> Validate and save</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

export function WorkspaceRecipeSettings({
  workspaces,
  recipes,
  defaultShell,
  defaultAgent,
  onCaptureWorkspace,
  onSaveWorkspace,
  onDeleteWorkspace,
  onOpenWorkspace,
  onSaveRecipe,
  onDeleteRecipe,
  onRunRecipe,
}: WorkspaceRecipeSettingsProps) {
  const [captureName, setCaptureName] = useState("");
  const [editingRecipe, setEditingRecipe] = useState<LaunchRecipeV1 | null>(null);
  const [renaming, setRenaming] = useState<{ kind: "workspace" | "recipe"; id: string; value: string } | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  const capture = () => {
    const error = onCaptureWorkspace(captureName.trim());
    if (error) {
      setMessage({ kind: "error", text: error });
      return;
    }
    setCaptureName("");
    setMessage({ kind: "success", text: "Workspace snapshot saved." });
  };

  const saveRename = () => {
    if (!renaming) return;
    const name = renaming.value.trim();
    if (!name) {
      setMessage({ kind: "error", text: "A name is required." });
      return;
    }
    const error = renaming.kind === "workspace"
      ? onSaveWorkspace({ ...workspaces.find(item => item.id === renaming.id)!, name, updatedAt: Date.now() })
      : onSaveRecipe({ ...recipes.find(item => item.id === renaming.id)!, name, updatedAt: Date.now() });
    if (error) {
      setMessage({ kind: "error", text: error });
      return;
    }
    setRenaming(null);
    setMessage({ kind: "success", text: "Name updated." });
  };

  const duplicateWorkspace = (workspace: WorkspaceV1) => {
    const now = Date.now();
    const error = onSaveWorkspace({ ...workspace, id: crypto.randomUUID(), name: `${workspace.name} Copy`, createdAt: now, updatedAt: now });
    setMessage(error ? { kind: "error", text: error } : { kind: "success", text: "Workspace duplicated." });
  };

  const duplicateRecipe = (recipe: LaunchRecipeV1) => {
    const now = Date.now();
    const copy = JSON.parse(JSON.stringify(recipe)) as LaunchRecipeV1;
    const error = onSaveRecipe({ ...copy, id: crypto.randomUUID(), name: `${recipe.name} Copy`, createdAt: now, updatedAt: now });
    setMessage(error ? { kind: "error", text: error } : { kind: "success", text: "Recipe duplicated." });
  };

  return (
    <div className="plan-settings">
      {message && (
        <div className={`plan-inline-message ${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>
          {message.kind === "error" ? <AlertTriangle size={13} /> : <Check size={13} />}
          <span>{message.text}</span>
          <button type="button" onClick={() => setMessage(null)} aria-label="Dismiss"><X size={11} /></button>
        </div>
      )}

      <section className="plan-library-section">
        <div className="plan-library-head">
          <div>
            <div className="plan-library-title"><Layers3 size={15} /> Workspaces</div>
            <p>Capture the exact ordered tabs, groups, active leaves, titles, pins, sessions, and split ratios in this window.</p>
          </div>
          <div className="plan-capture-row">
            <input value={captureName} onChange={event => setCaptureName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") capture(); }} placeholder="Workspace name" />
            <button type="button" className="btn btn-primary" disabled={!captureName.trim()} onClick={capture}><Save size={12} /> Save current</button>
          </div>
        </div>
        <div className="plan-card-list">
          {workspaces.length === 0 && <div className="plan-empty">No saved workspaces yet. Open the tabs you want, then capture the window.</div>}
          {workspaces.map(workspace => {
            const isRenaming = renaming?.kind === "workspace" && renaming.id === workspace.id;
            return (
              <div className="plan-card" key={workspace.id}>
                <div className="plan-card-main">
                  {isRenaming ? (
                    <input className="plan-rename-input" value={renaming.value} onChange={event => setRenaming({ ...renaming, value: event.target.value })} onKeyDown={event => { if (event.key === "Enter") saveRename(); if (event.key === "Escape") setRenaming(null); }} autoFocus />
                  ) : (
                    <div className="plan-card-name">{workspace.name}</div>
                  )}
                  <div className="plan-card-meta">{workspace.entries.length} entries / {workspaceTabCount(workspace)} terminals / updated {new Date(workspace.updatedAt).toLocaleDateString()}</div>
                </div>
                <div className="plan-card-actions">
                  {isRenaming ? (
                    <button type="button" onClick={saveRename}><Check size={12} /> Save</button>
                  ) : (
                    <button type="button" onClick={() => setRenaming({ kind: "workspace", id: workspace.id, value: workspace.name })}><Pencil size={12} /> Rename</button>
                  )}
                  <button type="button" onClick={() => duplicateWorkspace(workspace)}><Copy size={12} /> Duplicate</button>
                  <button type="button" onClick={() => void onOpenWorkspace(workspace.id, "merge")}><Merge size={12} /> Merge</button>
                  <button type="button" className="plan-primary-action" onClick={() => void onOpenWorkspace(workspace.id, "replace")}><RefreshCw size={12} /> Replace</button>
                  <button type="button" className="danger" onClick={() => { if (window.confirm(`Delete workspace '${workspace.name}'?`)) onDeleteWorkspace(workspace.id); }} aria-label={`Delete ${workspace.name}`}><Trash2 size={12} /></button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="plan-library-section">
        <div className="plan-library-head">
          <div>
            <div className="plan-library-title"><Play size={15} /> Launch recipes</div>
            <p>Preflight ordered agents, shells, structured commands, working directories, environment variables, and split layouts before opening anything.</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => setEditingRecipe(makeRecipe(defaultShell))}><Plus size={12} /> New recipe</button>
        </div>
        <div className="plan-card-list">
          {recipes.length === 0 && <div className="plan-empty">No launch recipes yet. Start with a safe shell template and add structured steps.</div>}
          {recipes.map(recipe => {
            const isRenaming = renaming?.kind === "recipe" && renaming.id === recipe.id;
            return (
              <div className="plan-card" key={recipe.id}>
                <div className="plan-card-main">
                  {isRenaming ? (
                    <input className="plan-rename-input" value={renaming.value} onChange={event => setRenaming({ ...renaming, value: event.target.value })} onKeyDown={event => { if (event.key === "Enter") saveRename(); if (event.key === "Escape") setRenaming(null); }} autoFocus />
                  ) : (
                    <div className="plan-card-name">{recipe.name}</div>
                  )}
                  <div className="plan-card-meta">{planCount(recipe.entries)} steps{recipe.projectPath ? ` / ${recipe.projectPath}` : " / uses current project or home"}</div>
                  {recipe.description && <div className="plan-card-description">{recipe.description}</div>}
                </div>
                <div className="plan-card-actions">
                  {isRenaming ? (
                    <button type="button" onClick={saveRename}><Check size={12} /> Save</button>
                  ) : (
                    <button type="button" onClick={() => setRenaming({ kind: "recipe", id: recipe.id, value: recipe.name })}><Pencil size={12} /> Rename</button>
                  )}
                  <button type="button" onClick={() => setEditingRecipe(recipe)}><Pencil size={12} /> Edit</button>
                  <button type="button" onClick={() => duplicateRecipe(recipe)}><Copy size={12} /> Duplicate</button>
                  <button type="button" className="plan-primary-action" onClick={() => void onRunRecipe(recipe.id)}><Play size={12} /> Run</button>
                  <button type="button" className="danger" onClick={() => { if (window.confirm(`Delete recipe '${recipe.name}'?`)) onDeleteRecipe(recipe.id); }} aria-label={`Delete ${recipe.name}`}><Trash2 size={12} /></button>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {editingRecipe && (
        <RecipeEditor
          recipe={editingRecipe}
          defaultShell={defaultShell}
          defaultAgent={defaultAgent}
          onSave={onSaveRecipe}
          onClose={() => setEditingRecipe(null)}
        />
      )}
    </div>
  );
}
