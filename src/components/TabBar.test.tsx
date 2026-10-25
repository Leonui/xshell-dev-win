// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { AGENT_IDS, type AgentId } from "../agents";
import { getDefaultInteractionSettings, type InteractionSettings } from "../lib/interactionSettings";
import type { Tab } from "../types";
import { TabBar, type TabBarEntry } from "./TabBar";

// TabBar resolves the current Tauri window while rendering; jsdom has no Tauri runtime.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ minimize: () => {}, toggleMaximize: () => {}, close: () => {} }),
}));

// jsdom does not implement ResizeObserver, which TabBar uses for scroll-overflow tracking.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

afterEach(cleanup);

const tab: Tab = { id: "tab-1", type: "terminal", title: "One", shellMode: "raw", shellId: "bash" };
const entries: TabBarEntry[] = [{ kind: "tab", id: tab.id, tab }];
const interactionSettings: InteractionSettings = getDefaultInteractionSettings("windows");

function renderBar() {
  return render(
    <TabBar
      tabs={[tab]}
      entries={entries}
      closingTabIds={new Set()}
      activeTabId={tab.id}
      selectedProject={null}
      hoveredProjectPath={null}
      linkedProjectPath={null}
      activeTabProject={null}
      openSessionIds={new Set()}
      projectIcons={{}}
      pinnedProjects={[]}
      sidebarCollapsed={false}
      defaultShell="bash"
      updateAvailable={false}
      interactionSettings={interactionSettings}
      closedCount={0}
      workspaces={[]}
      launchRecipes={[]}
      activities={{}}
      installedAgents={Object.fromEntries(AGENT_IDS.map(id => [id, false])) as Record<AgentId, boolean>}
      onExpandSidebar={() => {}}
      onSelectTab={() => {}}
      onCloseTab={() => {}}
      onReorderTabs={() => {}}
      onNewChat={() => {}}
      onNewChatInActive={() => {}}
      onNewShellInContext={() => {}}
      onOpenSession={() => {}}
      onNewShell={() => {}}
      onRenameTab={() => {}}
      onRenameGroup={() => {}}
      onTogglePin={() => {}}
      onReopenClosed={() => {}}
      onSaveWorkspace={() => {}}
      onOpenWorkspace={() => {}}
      onRunRecipe={() => {}}
      onGoHome={() => {}}
      onOpenSettings={() => {}}
      onToggleSidebar={() => {}}
    />,
  );
}

const badgeCount = (container: HTMLElement) => container.querySelectorAll(".tab-slot-badge").length;
const holdQuickSwitch = () => fireEvent.keyDown(window, { code: "AltLeft", key: "Alt", altKey: true });
const releaseQuickSwitch = () => fireEvent.keyUp(window, { code: "AltLeft", key: "Alt", altKey: false });

describe("TabBar quick-switch preview", () => {
  it("shows slot badges while the quick-switch modifiers are held and clears them on release", () => {
    const { container } = renderBar();
    expect(badgeCount(container)).toBe(0);

    holdQuickSwitch();
    expect(badgeCount(container)).toBe(1);

    releaseQuickSwitch();
    expect(badgeCount(container)).toBe(0);
  });

  it("keeps the preview down after a non-modifier key until the modifiers are released", () => {
    const { container } = renderBar();
    holdQuickSwitch();
    expect(badgeCount(container)).toBe(1);

    // Alt+B in readline: a real key is being typed with the chord, not a slot being chosen.
    fireEvent.keyDown(window, { code: "KeyB", key: "b", altKey: true });
    expect(badgeCount(container)).toBe(0);

    fireEvent.keyUp(window, { code: "KeyB", key: "b", altKey: true });
    expect(badgeCount(container)).toBe(0);

    releaseQuickSwitch();
    holdQuickSwitch();
    expect(badgeCount(container)).toBe(1);
  });

  it("clears the preview on window blur, pointer press, and focus change", () => {
    const { container } = renderBar();

    holdQuickSwitch();
    expect(badgeCount(container)).toBe(1);
    fireEvent.blur(window);
    expect(badgeCount(container)).toBe(0);

    holdQuickSwitch();
    expect(badgeCount(container)).toBe(1);
    fireEvent.pointerDown(window);
    expect(badgeCount(container)).toBe(0);

    holdQuickSwitch();
    expect(badgeCount(container)).toBe(1);
    fireEvent.focusIn(document.body);
    expect(badgeCount(container)).toBe(0);
  });

  it("clears the preview when the document is hidden", () => {
    const { container } = renderBar();
    holdQuickSwitch();
    expect(badgeCount(container)).toBe(1);

    const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    try {
      fireEvent(document, new Event("visibilitychange"));
      expect(badgeCount(container)).toBe(0);
    } finally {
      if (originalHidden) Object.defineProperty(document, "hidden", originalHidden);
      else delete (document as unknown as Record<string, unknown>).hidden;
    }
  });

  it("drops the preview when a rename starts", () => {
    const { container } = renderBar();
    holdQuickSwitch();
    expect(badgeCount(container)).toBe(1);

    const item = container.querySelector(".tab-item");
    expect(item).not.toBeNull();
    fireEvent.doubleClick(item!);

    expect(badgeCount(container)).toBe(0);
  });

  it("removes every capture-phase window listener it adds", () => {
    const added: Array<[string, EventListenerOrEventListenerObject, boolean]> = [];
    const removed: Array<[string, EventListenerOrEventListenerObject, boolean]> = [];
    const originalAdd = Object.getOwnPropertyDescriptor(window, "addEventListener");
    const originalRemove = Object.getOwnPropertyDescriptor(window, "removeEventListener");
    const underlyingAdd = window.addEventListener;
    const underlyingRemove = window.removeEventListener;

    window.addEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      added.push([type, listener, options === true]);
      underlyingAdd.call(window, type, listener, options);
    } as typeof window.addEventListener;
    window.removeEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) {
      removed.push([type, listener, options === true]);
      underlyingRemove.call(window, type, listener, options);
    } as typeof window.removeEventListener;

    try {
      const { unmount } = renderBar();
      unmount();
    } finally {
      if (originalAdd) Object.defineProperty(window, "addEventListener", originalAdd);
      else delete (window as unknown as Record<string, unknown>).addEventListener;
      if (originalRemove) Object.defineProperty(window, "removeEventListener", originalRemove);
      else delete (window as unknown as Record<string, unknown>).removeEventListener;
    }

    // Capture-phase registrations are the easiest to leak: removeEventListener only matches
    // when the capture flag is passed again, so a mismatch leaves a handler running forever.
    const captureAdds = added.filter(([, , capture]) => capture);
    expect(captureAdds.length).toBeGreaterThan(0);
    for (const [type, listener] of captureAdds) {
      expect(removed).toContainEqual([type, listener, true]);
    }
  });
});
