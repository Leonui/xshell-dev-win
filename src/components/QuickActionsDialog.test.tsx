// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AGENT_IDS, type AgentId } from "../agents";
import { shouldIgnoreGlobalShortcut, type KeyEventLike } from "../lib/keybindings";
import { QuickActionsDialog } from "./QuickActionsDialog";

afterEach(cleanup);

describe("QuickActionsDialog", () => {
  it("is an active modal, suppresses global shortcuts, and closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <QuickActionsDialog
        tabs={[]}
        activeTabId="home"
        projectIcons={{}}
        pinnedProjects={[]}
        contextProject={null}
        hoveredProjectPath={null}
        linkedProjectPath={null}
        selectedProjectPath={null}
        hasActiveTab={false}
        closedCount={0}
        workspaces={[]}
        launchRecipes={[]}
        installedAgents={Object.fromEntries(AGENT_IDS.map(id => [id, false])) as Record<AgentId, boolean>}
        onSelectTab={() => {}}
        onCloseTab={() => {}}
        onReopenClosed={() => {}}
        onSaveWorkspace={() => {}}
        onOpenWorkspace={() => {}}
        onRunRecipe={() => {}}
        onNewChat={() => {}}
        onNewShell={() => {}}
        onGoHome={() => {}}
        onOpenSettings={() => {}}
        onToggleSidebar={() => {}}
        onClose={onClose}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Quick Actions" }).getAttribute("aria-modal")).toBe("true");
    expect(shouldIgnoreGlobalShortcut({
      code: "Digit1", key: "1", ctrlKey: false, altKey: true, shiftKey: false, metaKey: false,
    } satisfies KeyEventLike)).toBe(true);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
