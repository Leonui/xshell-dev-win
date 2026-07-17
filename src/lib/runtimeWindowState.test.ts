import { describe, expect, it } from "vitest";
import type { Group, Tab } from "../types";
import { createWindowState, decodeRuntimeWindowState, filterStartupWindowState, findActiveRuntimeTab, launchFromRuntimeTab, preservePendingCommandConfirmations, requireConfirmationForNewCommandTabs } from "./runtimeWindowState";
import { closeWindowEntry, closeWindowPane, undoLastClosed, validateWindowState, type IdFactory, type WindowStateV1 } from "./windowState";

const shell = (id: string, pinned = false): Tab => ({
  id,
  type: "terminal",
  title: id,
  projectPath: "C:\\repo",
  shellMode: "raw",
  shellId: "powershell",
  pinned,
});

const command = (id: string, groupId?: string): Tab => ({
  ...shell(id),
  ...(groupId ? { groupId } : {}),
  launch: { kind: "command", shellId: "powershell", command: { kind: "argv", program: "npm", args: ["test"] } },
  requiresLaunchConfirmation: true,
});

function ids(...values: string[]): IdFactory {
  let index = 0;
  return () => values[index++] ?? `generated-${index}`;
}

function applyRuntime(state: WindowStateV1, previousTabs: readonly Tab[], confirmNewCommands = false) {
  const decoded = decodeRuntimeWindowState(state, { confirmCommands: false });
  const gated = confirmNewCommands
    ? requireConfirmationForNewCommandTabs(decoded, previousTabs)
    : decoded;
  return preservePendingCommandConfirmations(gated, previousTabs);
}

describe("runtime window-state adapter", () => {
  it("resolves the focused leaf as the active tab for mixed-project groups", () => {
    const tabs = [
      { ...shell("left"), projectPath: "C:\\left", groupId: "g" },
      { ...shell("right"), projectPath: "C:\\right", groupId: "g" },
    ];
    const groups: Group[] = [{
      id: "g", name: "Pair",
      layout: { kind: "split", direction: "row", ratio: 0.5, children: [{ kind: "leaf", tabId: "left" }, { kind: "leaf", tabId: "right" }] },
    }];
    expect(findActiveRuntimeTab(tabs, groups, "g", { g: "right" })?.projectPath).toBe("C:\\right");
  });

  it("infers versioned launch specs from legacy runtime fields", () => {
    expect(launchFromRuntimeTab(shell("s"))).toEqual({ kind: "shell", shellId: "powershell" });
    expect(launchFromRuntimeTab({ ...shell("a"), shellMode: "claude", sessionId: "sid", agent: "codex" }))
      .toEqual({ kind: "session", agent: "codex", sessionId: "sid", hostShellId: "powershell" });
  });

  it("keeps pinned entries in a stable left partition and validates", () => {
    const tabs = [shell("a"), shell("b", true), { ...shell("c"), groupId: "g" }];
    const groups: Group[] = [{
      id: "g",
      name: "Group",
      pinned: true,
      layout: { kind: "split", direction: "col", ratio: 0.5, children: [{ kind: "leaf", tabId: "c" }, { kind: "leaf", tabId: "d" }] },
    }];
    tabs.push({ ...shell("d"), groupId: "g" });
    const state = createWindowState(tabs, groups, "g", { g: "d" });
    expect(state.entryOrder.map(entry => entry.id)).toEqual(["b", "g", "a"]);
    expect(validateWindowState(state)).toEqual([]);
  });

  it("hydrates tabs in persisted entry and group-layout order", () => {
    const state: WindowStateV1 = {
      version: 1,
      tabs: [
        { id: "last", title: "Last", projectPath: "", launch: { kind: "shell", shellId: "powershell" } },
        { id: "right", title: "Right", projectPath: "", launch: { kind: "shell", shellId: "powershell" }, groupId: "g" },
        { id: "first", title: "First", projectPath: "", launch: { kind: "shell", shellId: "powershell" } },
        { id: "left", title: "Left", projectPath: "", launch: { kind: "shell", shellId: "powershell" }, groupId: "g" },
      ],
      groups: [{ id: "g", name: "Pair", layout: { kind: "split", direction: "row", ratio: 0.5, children: [{ kind: "leaf", tabId: "left" }, { kind: "leaf", tabId: "right" }] } }],
      entryOrder: [{ kind: "tab", id: "first" }, { kind: "group", id: "g" }, { kind: "tab", id: "last" }],
      activeEntryId: "first",
      activeLeafByGroup: { g: "left" },
    };
    expect(decodeRuntimeWindowState(state).tabs.map(tab => tab.id)).toEqual(["first", "left", "right", "last"]);
  });

  it("keeps a reopened entry at its persisted position after runtime hydration", () => {
    const initial = createWindowState([shell("first"), shell("second")], [], "first", {});
    const closed = closeWindowEntry(initial, [], "first", { idFactory: ids("record") });
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    const restored = undoLastClosed(closed.state, closed.history, { idFactory: ids("first-new") });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.state.tabs.map(tab => tab.id)).toEqual(["second", "first-new"]);
    expect(decodeRuntimeWindowState(restored.state).tabs.map(tab => tab.id)).toEqual(["first-new", "second"]);
  });

  it("hydrates command tabs as confirmation-gated", () => {
    const runtime = decodeRuntimeWindowState({
      version: 1,
      tabs: [{ id: "cmd", title: "Build", projectPath: "C:\\repo", launch: { kind: "command", shellId: "powershell", command: { kind: "argv", program: "npm", args: ["test"] } } }],
      groups: [], entryOrder: [{ kind: "tab", id: "cmd" }], activeEntryId: "cmd", activeLeafByGroup: {},
    });
    expect(runtime.tabs[0]).toMatchObject({ shellMode: "raw", shellId: "powershell", requiresLaunchConfirmation: true });
  });

  it("preserves pending command trust across unrelated window-state changes", () => {
    const command = decodeRuntimeWindowState({
      version: 1,
      tabs: [{ id: "cmd", title: "Build", projectPath: "C:\\repo", launch: { kind: "command", shellId: "powershell", command: { kind: "argv", program: "npm", args: ["test"] } } }],
      groups: [], entryOrder: [{ kind: "tab", id: "cmd" }], activeEntryId: "cmd", activeLeafByGroup: {},
    }).tabs[0];
    const decoded = decodeRuntimeWindowState(
      createWindowState([command, shell("other")], [], "cmd", {}),
      { confirmCommands: false },
    );
    expect(decoded.tabs.find(tab => tab.id === "cmd")?.requiresLaunchConfirmation).toBe(false);
    expect(
      preservePendingCommandConfirmations(decoded, [command]).tabs
        .find(tab => tab.id === "cmd")?.requiresLaunchConfirmation,
    ).toBe(true);
  });

  it.each(["tab", "group", "pane"] as const)("reapplies command trust after reopening a closed %s", kind => {
    const group: Group = {
      id: "g",
      name: "Commands",
      layout: { kind: "split", direction: "row", ratio: 0.5, children: [{ kind: "leaf", tabId: "cmd" }, { kind: "leaf", tabId: "peer" }] },
    };
    const initialTabs = kind === "tab"
      ? [command("cmd")]
      : [command("cmd", "g"), { ...shell("peer"), groupId: "g" }];
    const initial = createWindowState(initialTabs, kind === "tab" ? [] : [group], kind === "tab" ? "cmd" : "g", { g: "cmd" });
    const closed = kind === "pane"
      ? closeWindowPane(initial, [], "cmd")
      : closeWindowEntry(initial, [], kind === "tab" ? "cmd" : "g");
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    const afterClose = applyRuntime(closed.state, initialTabs);
    const restored = undoLastClosed(
      createWindowState(afterClose.tabs, afterClose.groups, afterClose.activeEntryId, afterClose.activeLeafByGroup),
      closed.history,
      { idFactory: ids("restored-group", "restored-command", "restored-peer") },
    );
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    const reopened = applyRuntime(restored.state, afterClose.tabs, true);
    const reopenedCommands = reopened.tabs.filter(tab => tab.launch?.kind === "command" && !afterClose.tabs.some(previous => previous.id === tab.id));
    expect(reopenedCommands).toHaveLength(1);
    expect(reopenedCommands[0].requiresLaunchConfirmation).toBe(true);
  });

  it("restores only complete pinned entries when unpinned restore is disabled", () => {
    const state = createWindowState(
      [shell("loose"), shell("pin", true), { ...shell("left"), groupId: "g" }, { ...shell("right"), groupId: "g" }],
      [{ id: "g", name: "Pinned pair", pinned: true, layout: { kind: "split", direction: "row", ratio: 0.4, children: [{ kind: "leaf", tabId: "left" }, { kind: "leaf", tabId: "right" }] } }],
      "loose",
      { g: "right" },
    );
    const filtered = filterStartupWindowState(state, false);
    expect(filtered.entryOrder.map(entry => entry.id)).toEqual(["pin", "g"]);
    expect(filtered.tabs.map(tab => tab.id)).toEqual(["pin", "left", "right"]);
    expect(filtered.activeEntryId).toBe("pin");
    expect(validateWindowState(filtered)).toEqual([]);
  });
});
