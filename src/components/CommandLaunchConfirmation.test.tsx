// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Tab } from "../types";
import { CommandLaunchConfirmation } from "./CommandLaunchConfirmation";

afterEach(cleanup);

describe("CommandLaunchConfirmation", () => {
  const tab: Tab = {
    id: "command-tab",
    type: "terminal",
    title: "Tests",
    projectPath: "",
    shellMode: "raw",
    shellId: "powershell",
    launch: {
      kind: "command",
      shellId: "powershell",
      command: { kind: "argv", program: "npm", args: ["test", "--", "--run"] },
      env: { CI: "true" },
    },
  };

  it("shows the exact command context and starts only after an explicit click", () => {
    const onConfirm = vi.fn();
    render(<CommandLaunchConfirmation tab={tab} awaiting onConfirm={onConfirm} />);

    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText(JSON.stringify(tab.launch && tab.launch.kind === "command" ? tab.launch.command : {}))).toBeTruthy();
    expect(screen.getByText(JSON.stringify({ shellId: "powershell", cwd: "<home>", env: { CI: "true" } }))).toBeTruthy();
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Start command" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("renders nothing after trust is cleared", () => {
    const { container } = render(<CommandLaunchConfirmation tab={tab} awaiting={false} onConfirm={() => {}} />);
    expect(container.innerHTML).toBe("");
  });
});
