import { AlertTriangle } from "lucide-react";
import type { Tab } from "../types";

interface CommandLaunchConfirmationProps {
  tab: Tab;
  awaiting: boolean;
  onConfirm: () => void;
}

export function CommandLaunchConfirmation({ tab, awaiting, onConfirm }: CommandLaunchConfirmationProps) {
  if (!awaiting || tab.launch?.kind !== "command") return null;
  return (
    <div className="terminal-command-confirm" role="alertdialog" aria-labelledby={`command-title-${tab.id}`}>
      <div className="terminal-command-confirm-mark"><AlertTriangle size={16} /></div>
      <div className="terminal-command-confirm-copy">
        <strong id={`command-title-${tab.id}`}>Command restored but not started</strong>
        <span>Review the exact persisted launch specification before starting it.</span>
        <code>{JSON.stringify(tab.launch.command)}</code>
        <code>{JSON.stringify({ shellId: tab.launch.shellId, cwd: tab.projectPath || "<home>", env: tab.launch.env || {} })}</code>
      </div>
      <button type="button" className="btn btn-primary" onClick={onConfirm}>Start command</button>
    </div>
  );
}
