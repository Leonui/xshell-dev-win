import { describe, expect, it } from "vitest";
import {
  CLOSED_HISTORY_LIMIT,
  WINDOW_STATE_VERSION,
  closeWindowEntry,
  closeWindowPane,
  migrateLegacyWindowState,
  pushClosedRecord,
  undoLastClosed,
  validateWindowState,
  type ClosedRecordV1,
  type IdFactory,
  type WindowStateV1,
} from "./windowState";

function ids(...values: string[]): IdFactory {
  let index = 0;
  return () => values[index++] ?? `generated-${index}`;
}

function groupedState(pinned = false): WindowStateV1 {
  return {
    version: WINDOW_STATE_VERSION,
    tabs: [
      { id: "a", title: "A", projectPath: "/repo", launch: { kind: "session", agent: "claude", sessionId: "sa" }, groupId: "g" },
      { id: "b", title: "B", projectPath: "/repo", launch: { kind: "shell", shellId: "bash" }, groupId: "g" },
      { id: "c", title: "C", projectPath: "/other", launch: { kind: "agent", agent: "codex" } },
    ],
    groups: [{
      id: "g",
      name: "Work",
      pinned,
      layout: { kind: "split", direction: "col", ratio: 0.31, children: [{ kind: "leaf", tabId: "a" }, { kind: "leaf", tabId: "b" }] },
    }],
    entryOrder: [{ kind: "tab", id: "c" }, { kind: "group", id: "g" }],
    activeEntryId: "g",
    activeLeafByGroup: { g: "b" },
  };
}

describe("window state migration and validation", () => {
  it("migrates legacy tabs and preserves group ratios", () => {
    const result = migrateLegacyWindowState({
      open_tabs: [
        { id: "a", type: "terminal", title: "Agent", sessionId: "s1", agent: "claude", projectPath: "/repo", groupId: "g" },
        { id: "b", type: "terminal", title: "Shell", shellMode: "raw", shellId: "bash", projectPath: "/repo", groupId: "g" },
      ],
      open_groups: [{ id: "g", name: "Pair", layout: { kind: "split", direction: "row", ratio: 0.73, children: [{ kind: "leaf", tabId: "a" }, { kind: "leaf", tabId: "b" }] } }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.groups[0].layout).toMatchObject({ direction: "row", ratio: 0.73 });
    expect(result.value.tabs[1].launch).toEqual({ kind: "shell", shellId: "bash" });
    expect(result.value.entryOrder).toEqual([{ kind: "group", id: "g" }]);
    expect(validateWindowState(result.value)).toEqual([]);
  });

  it("rejects every environment variable reserved by the native launcher", () => {
    const state: WindowStateV1 = {
      version: WINDOW_STATE_VERSION,
      tabs: [{
        id: "command",
        title: "Unsafe command",
        projectPath: "/repo",
        launch: {
          kind: "command",
          shellId: "bash",
          command: { kind: "argv", program: "npm", args: ["test"] },
          env: { xShell_activity_dir: "attacker", term_program: "attacker", Path: "attacker", pathext: "attacker" },
        },
      }],
      groups: [],
      entryOrder: [{ kind: "tab", id: "command" }],
      activeEntryId: "command",
      activeLeafByGroup: {},
    };
    expect(validateWindowState(state).filter(issue => issue.code === "reserved_env")).toHaveLength(4);
  });
});

describe("close and undo transactions", () => {
  it("protects every pane in a pinned group", () => {
    const state = groupedState(true);
    const before = JSON.stringify(state);
    const entry = closeWindowEntry(state, [], "g");
    const pane = closeWindowPane(state, [], "b");
    expect(entry).toMatchObject({ ok: false, code: "pinned" });
    expect(pane).toMatchObject({ ok: false, code: "pinned" });
    expect(JSON.stringify(state)).toBe(before);
  });

  it("reopens a whole group with fresh ids, exact ratio, order, and active leaf", () => {
    const closed = closeWindowEntry(groupedState(), [], "g", { now: 10, idFactory: ids("closed-1") });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    const restored = undoLastClosed(closed.state, closed.history, { idFactory: ids("g-new", "a-new", "b-new") });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.state.entryOrder).toEqual([{ kind: "tab", id: "c" }, { kind: "group", id: "g-new" }]);
    expect(restored.state.groups[0].layout).toEqual({ kind: "split", direction: "col", ratio: 0.31, children: [{ kind: "leaf", tabId: "a-new" }, { kind: "leaf", tabId: "b-new" }] });
    expect(restored.state.activeEntryId).toBe("g-new");
    expect(restored.state.activeLeafByGroup["g-new"]).toBe("b-new");
    expect(restored.history).toEqual([]);
  });

  it("reconstructs a dissolved two-pane group without reusing the closed tab id", () => {
    const closed = closeWindowPane(groupedState(), [], "b", { idFactory: ids("closed-pane") });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.state.entryOrder).toEqual([{ kind: "tab", id: "c" }, { kind: "tab", id: "a" }]);
    const restored = undoLastClosed(closed.state, closed.history, { idFactory: ids("b-new", "g-new") });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.state.groups[0].layout).toEqual({ kind: "split", direction: "col", ratio: 0.31, children: [{ kind: "leaf", tabId: "a" }, { kind: "leaf", tabId: "b-new" }] });
    expect(restored.state.activeLeafByGroup["g-new"]).toBe("b-new");
    expect(validateWindowState(restored.state)).toEqual([]);
  });

  it("remaps older pane history after restoring a newer dissolved-group pane", () => {
    const initial: WindowStateV1 = {
      version: 1,
      tabs: [
        { id: "a", title: "A", projectPath: "/repo", launch: { kind: "shell", shellId: "bash" }, groupId: "g" },
        { id: "b", title: "B", projectPath: "/repo", launch: { kind: "shell", shellId: "bash" }, groupId: "g" },
        { id: "c", title: "C", projectPath: "/repo", launch: { kind: "shell", shellId: "bash" }, groupId: "g" },
      ],
      groups: [{
        id: "g",
        name: "Three panes",
        layout: {
          kind: "split", direction: "row", ratio: 0.5,
          children: [
            { kind: "leaf", tabId: "a" },
            { kind: "split", direction: "col", ratio: 0.5, children: [{ kind: "leaf", tabId: "b" }, { kind: "leaf", tabId: "c" }] },
          ],
        },
      }],
      entryOrder: [{ kind: "group", id: "g" }], activeEntryId: "g", activeLeafByGroup: { g: "c" },
    };
    const closedC = closeWindowPane(initial, [], "c", { idFactory: ids("closed-c") });
    expect(closedC.ok).toBe(true);
    if (!closedC.ok) return;
    const closedB = closeWindowPane(closedC.state, closedC.history, "b", { idFactory: ids("closed-b") });
    expect(closedB.ok).toBe(true);
    if (!closedB.ok) return;
    const restoredB = undoLastClosed(closedB.state, closedB.history, { idFactory: ids("b-new", "g-new") });
    expect(restoredB.ok).toBe(true);
    if (!restoredB.ok) return;
    const restoredC = undoLastClosed(restoredB.state, restoredB.history, { idFactory: ids("c-new") });
    expect(restoredC.ok).toBe(true);
    if (!restoredC.ok) return;
    expect(restoredC.state.groups[0].id).toBe("g-new");
    expect(new Set(restoredC.state.tabs.map(tab => tab.id))).toEqual(new Set(["a", "b-new", "c-new"]));
    expect(validateWindowState(restoredC.state)).toEqual([]);
  });

  it("remaps older pane history after restoring a newer whole-group close", () => {
    const initial: WindowStateV1 = {
      version: 1,
      tabs: [
        { id: "a", title: "A", projectPath: "/repo", launch: { kind: "shell", shellId: "bash" }, groupId: "g" },
        { id: "b", title: "B", projectPath: "/repo", launch: { kind: "shell", shellId: "bash" }, groupId: "g" },
        { id: "c", title: "C", projectPath: "/repo", launch: { kind: "shell", shellId: "bash" }, groupId: "g" },
      ],
      groups: [{
        id: "g", name: "Three panes",
        layout: {
          kind: "split", direction: "row", ratio: 0.5,
          children: [
            { kind: "leaf", tabId: "a" },
            { kind: "split", direction: "col", ratio: 0.5, children: [{ kind: "leaf", tabId: "b" }, { kind: "leaf", tabId: "c" }] },
          ],
        },
      }],
      entryOrder: [{ kind: "group", id: "g" }], activeEntryId: "g", activeLeafByGroup: { g: "c" },
    };
    const closedPane = closeWindowPane(initial, [], "c", { idFactory: ids("closed-pane") });
    expect(closedPane.ok).toBe(true);
    if (!closedPane.ok) return;
    const closedGroup = closeWindowEntry(closedPane.state, closedPane.history, "g", { idFactory: ids("closed-group") });
    expect(closedGroup.ok).toBe(true);
    if (!closedGroup.ok) return;
    const restoredGroup = undoLastClosed(closedGroup.state, closedGroup.history, { idFactory: ids("g-new", "a-new", "b-new") });
    expect(restoredGroup.ok).toBe(true);
    if (!restoredGroup.ok) return;
    const restoredPane = undoLastClosed(restoredGroup.state, restoredGroup.history, { idFactory: ids("c-new") });
    expect(restoredPane.ok).toBe(true);
    if (!restoredPane.ok) return;
    expect(new Set(restoredPane.state.tabs.map(tab => tab.id))).toEqual(new Set(["a-new", "b-new", "c-new"]));
    expect(validateWindowState(restoredPane.state)).toEqual([]);
  });

  it("keeps the newest capped LIFO records", () => {
    let history: ClosedRecordV1[] = [];
    for (let i = 0; i < CLOSED_HISTORY_LIMIT + 3; i++) {
      history = pushClosedRecord(history, { version: 1, kind: "tab", id: `r${i}`, closedAt: i, entryIndex: 0, tab: { id: `t${i}`, title: "T", projectPath: "", launch: { kind: "shell", shellId: "bash" } } });
    }
    expect(history).toHaveLength(CLOSED_HISTORY_LIMIT);
    expect(history[0].id).toBe("r3");
    expect(history[history.length - 1]?.id).toBe(`r${CLOSED_HISTORY_LIMIT + 2}`);
  });

  it("rejects duplicate-session undo without consuming history or mutating state", () => {
    const initial: WindowStateV1 = {
      version: 1,
      tabs: [{ id: "old", title: "Old", projectPath: "/repo", launch: { kind: "session", agent: "claude", sessionId: "same" } }],
      groups: [], entryOrder: [{ kind: "tab", id: "old" }], activeEntryId: "old", activeLeafByGroup: {},
    };
    const closed = closeWindowEntry(initial, [], "old", { idFactory: ids("record") });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    const conflictState: WindowStateV1 = {
      ...closed.state,
      tabs: [{ id: "live", title: "Live", projectPath: "/repo", launch: { kind: "session", agent: "claude", sessionId: "same" } }],
      entryOrder: [{ kind: "tab", id: "live" }], activeEntryId: "live",
    };
    const before = JSON.stringify(conflictState);
    const result = undoLastClosed(conflictState, closed.history, { idFactory: ids("unused") });
    expect(result).toMatchObject({ ok: false, code: "conflict" });
    expect(result.history).toHaveLength(1);
    expect(JSON.stringify(conflictState)).toBe(before);
  });
});
