import { describe, expect, it } from "vitest";
import {
  captureWorkspace,
  decodeLaunchRecipe,
  decodeWorkspace,
  effectiveWorkspaceForPreflight,
  isAbsoluteRecipePath,
  materializeLaunchRecipe,
  materializeWorkspace,
  preflightLaunchRecipe,
  preflightWorkspace,
  type LaunchRecipeV1,
} from "./launchPlans";
import { type IdFactory, type WindowStateV1 } from "./windowState";

function ids(...values: string[]): IdFactory {
  let index = 0;
  return () => values[index++] ?? `generated-${index}`;
}

function state(): WindowStateV1 {
  return {
    version: 1,
    tabs: [
      { id: "solo", title: "Solo", customTitle: "Logs", projectPath: "/logs", launch: { kind: "shell", shellId: "bash" }, pinned: true },
      { id: "left", title: "Left", projectPath: "/repo", launch: { kind: "session", agent: "claude", sessionId: "s1" }, groupId: "group" },
      { id: "right", title: "Right", projectPath: "/repo", launch: { kind: "agent", agent: "codex" }, groupId: "group" },
    ],
    groups: [{ id: "group", name: "Build", layout: { kind: "split", direction: "row", ratio: 0.64, children: [{ kind: "leaf", tabId: "left" }, { kind: "leaf", tabId: "right" }] } }],
    entryOrder: [{ kind: "tab", id: "solo" }, { kind: "group", id: "group" }],
    activeEntryId: "group",
    activeLeafByGroup: { group: "right" },
  };
}

describe("workspace snapshots", () => {
  it("rejects malformed workspace entries without throwing", () => {
    const malformed = {
      version: 1, id: "bad", name: "Bad", createdAt: 1, updatedAt: 1,
      entries: [{ kind: "group", key: "broken", tabs: null }],
    };
    expect(() => decodeWorkspace(malformed)).not.toThrow();
    expect(decodeWorkspace(malformed).ok).toBe(false);
  });

  it("round-trips entry order, group ratio, active leaf, titles, and fresh ids", () => {
    const captured = captureWorkspace(state(), { id: "ws", name: "Daily", now: 5 });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const empty: WindowStateV1 = { version: 1, tabs: [], groups: [], entryOrder: [], activeEntryId: "home", activeLeafByGroup: {} };
    const restored = materializeWorkspace(captured.value, empty, { mode: "replace", idFactory: ids("solo-new", "left-new", "right-new", "group-new") });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.state.entryOrder).toEqual([{ kind: "tab", id: "solo-new" }, { kind: "group", id: "group-new" }]);
    expect(restored.value.state.groups[0].layout).toEqual({ kind: "split", direction: "row", ratio: 0.64, children: [{ kind: "leaf", tabId: "left-new" }, { kind: "leaf", tabId: "right-new" }] });
    expect(restored.value.state.activeEntryId).toBe("group-new");
    expect(restored.value.state.activeLeafByGroup["group-new"]).toBe("right-new");
    expect(restored.value.state.tabs[0]).toMatchObject({ id: "solo-new", customTitle: "Logs", pinned: true });
  });

  it("skips a duplicate-session entry during merge and reports it", () => {
    const captured = captureWorkspace(state(), { id: "ws", name: "Daily", now: 5 });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const current: WindowStateV1 = {
      version: 1,
      tabs: [{ id: "existing", title: "Existing", projectPath: "/repo", launch: { kind: "session", agent: "claude", sessionId: "s1" } }],
      groups: [], entryOrder: [{ kind: "tab", id: "existing" }], activeEntryId: "existing", activeLeafByGroup: {},
    };
    const result = materializeWorkspace(captured.value, current, { mode: "merge", idFactory: ids("solo-new") });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skippedEntries).toEqual([{ key: "group-1", reason: "duplicate-session" }]);
    expect(result.value.state.entryOrder).toEqual([{ kind: "tab", id: "existing" }, { kind: "tab", id: "solo-new" }]);
    expect(current.tabs).toHaveLength(1);
    const effective = effectiveWorkspaceForPreflight(captured.value, current, "merge");
    expect(effective.workspace.entries.map(entry => entry.kind === "tab" ? entry.tab.key : entry.key)).toEqual(["tab-1"]);
    expect(preflightWorkspace(captured.value, current, "merge", {
      pathExists: path => path === "/logs",
    }).some(issue => issue.code === "missing_cwd")).toBe(false);
  });

  it("refuses replace when a workspace session conflicts with a retained pinned entry", () => {
    const captured = captureWorkspace(state(), { id: "ws", name: "Daily", now: 5 });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const current: WindowStateV1 = {
      version: 1,
      tabs: [{ id: "existing", title: "Existing", projectPath: "/repo", launch: { kind: "session", agent: "claude", sessionId: "s1" }, pinned: true }],
      groups: [], entryOrder: [{ kind: "tab", id: "existing" }], activeEntryId: "existing", activeLeafByGroup: {},
    };
    const result = materializeWorkspace(captured.value, current, { mode: "replace", idFactory: ids("never-used") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some(issue => issue.code === "duplicate_session")).toBe(true);
  });
});

describe("project launch recipes", () => {
  it("recognizes Windows, UNC, and POSIX absolute cwd paths only", () => {
    expect(isAbsoluteRecipePath("C:\\repo")).toBe(true);
    expect(isAbsoluteRecipePath("\\\\server\\share")).toBe(true);
    expect(isAbsoluteRecipePath("/repo")).toBe(true);
    expect(isAbsoluteRecipePath("C:repo")).toBe(false);
    expect(isAbsoluteRecipePath("relative/repo")).toBe(false);
  });

  const recipe: LaunchRecipeV1 = {
    version: 1,
    id: "dev",
    name: "Dev stack",
    createdAt: 1,
    updatedAt: 1,
    activeEntryKey: "stack",
    entries: [{
      kind: "group",
      key: "stack",
      name: "Services",
      activeLeafKey: "server",
      tabs: [
        { key: "server", title: "Server", cwd: { kind: "project" }, launch: { kind: "command", shellId: "bash", command: { kind: "argv", program: "npm", args: ["run", "dev server"] }, env: { PORT: "4100" }, keepOpen: true } },
        { key: "agent", title: "Agent", cwd: { kind: "project" }, launch: { kind: "agent", agent: "codex", hostShellId: "bash" } },
      ],
      layout: { kind: "split", direction: "col", ratio: 0.42, children: [{ kind: "leaf", tabKey: "server" }, { kind: "leaf", tabKey: "agent" }] },
    }],
  };

  it("preflights all dependencies before returning a plan", () => {
    const failed = preflightLaunchRecipe(recipe, { installedAgents: new Set(), availableShellIds: new Set(["bash"]) });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(["missing_project", "missing_agent"]));
  });

  it("materializes a valid recipe atomically and preserves argv/env/layout", () => {
    const empty: WindowStateV1 = { version: 1, tabs: [], groups: [], entryOrder: [], activeEntryId: "home", activeLeafByGroup: {} };
    const result = materializeLaunchRecipe(recipe, empty, {
      context: { projectPath: "/repo", installedAgents: new Set(["codex"]), availableShellIds: new Set(["bash"]), pathExists: path => path === "/repo" },
      idFactory: ids("server-id", "agent-id", "group-id"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.state.groups[0].layout).toEqual({ kind: "split", direction: "col", ratio: 0.42, children: [{ kind: "leaf", tabId: "server-id" }, { kind: "leaf", tabId: "agent-id" }] });
    expect(result.value.state.tabs[0].launch).toEqual({ kind: "command", shellId: "bash", command: { kind: "argv", program: "npm", args: ["run", "dev server"] }, env: { PORT: "4100" }, keepOpen: true });
    expect(result.value.state.activeLeafByGroup["group-id"]).toBe("server-id");
  });

  it("migrates an unversioned recipe envelope", () => {
    const { version: _version, createdAt: _created, updatedAt: _updated, ...legacy } = recipe;
    const decoded = decodeLaunchRecipe(legacy, 99);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded).toMatchObject({ migrated: true, value: { version: 1, createdAt: 99, updatedAt: 99 } });
  });
});
