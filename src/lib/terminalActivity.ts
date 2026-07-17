export type TerminalKind = "agent" | "raw";

export type TerminalActivityPhase =
  | "starting"
  | "idle"
  | "running"
  | "waiting"
  | "exited";

export type TerminalActivityReason =
  | "turn-complete"
  | "permission"
  | "input"
  | "agent-failed"
  | "process-exit"
  | "spawn-error";

export interface TerminalActivity {
  terminalKind: TerminalKind;
  phase: TerminalActivityPhase;
  reason: TerminalActivityReason | null;
  unread: boolean;
  /** A prompt was submitted in this process generation and has not completed. */
  armed: boolean;
  generation: number;
  runId: string | null;
  lastSeq: number;
  lastEventId: string | null;
  recentEventIds: readonly string[];
  lastSource: ActivityEvent["source"] | null;
  updatedAt: number;
  acknowledgedAt: number | null;
  exitCode: number | null;
}

interface EventBase {
  eventId: string;
  generation: number;
  runId: string;
  seq: number;
  at: number;
}

export type PtyActivityEvent = EventBase &
  (
    | { source: "pty"; kind: "spawn-started" }
    | { source: "pty"; kind: "spawn-ready" }
    | { source: "pty"; kind: "spawn-failed" }
    | {
        source: "pty";
        kind: "process-exited";
        exitCode: number;
        intentional?: boolean;
      }
  );

export type HookActivityEvent = EventBase &
  (
    | { source: "hook"; kind: "prompt-submitted" }
    | { source: "hook"; kind: "work-resumed" }
    | { source: "hook"; kind: "turn-completed" }
    | { source: "hook"; kind: "needs-permission" }
    | { source: "hook"; kind: "needs-input" }
    | { source: "hook"; kind: "agent-failed" }
  );

export type ActivityEvent = PtyActivityEvent | HookActivityEvent;

export interface ActivityReduceContext {
  /** True only when this exact terminal leaf is visible and the app window is focused. */
  isAttended: boolean;
}

const MAX_RECENT_EVENT_IDS = 32;

const PTY_EVENT_KINDS = new Set<string>([
  "spawn-started",
  "spawn-ready",
  "spawn-failed",
  "process-exited",
]);

const HOOK_EVENT_KINDS = new Set<string>([
  "prompt-submitted",
  "work-resumed",
  "turn-completed",
  "needs-permission",
  "needs-input",
  "agent-failed",
]);

export function createTerminalActivity(
  terminalKind: TerminalKind,
  at = 0,
): TerminalActivity {
  return {
    terminalKind,
    phase: "idle",
    reason: null,
    unread: false,
    armed: false,
    generation: -1,
    runId: null,
    lastSeq: -1,
    lastEventId: null,
    recentEventIds: [],
    lastSource: null,
    updatedAt: at,
    acknowledgedAt: null,
    exitCode: null,
  };
}

function isWellFormedEvent(event: ActivityEvent): boolean {
  return (
    event.eventId.trim().length > 0 &&
    event.runId.trim().length > 0 &&
    Number.isSafeInteger(event.generation) &&
    event.generation >= 0 &&
    Number.isSafeInteger(event.seq) &&
    event.seq >= 0 &&
    Number.isFinite(event.at) &&
    event.at >= 0 &&
    (event.source === "pty"
      ? PTY_EVENT_KINDS.has(event.kind)
      : HOOK_EVENT_KINDS.has(event.kind))
  );
}

function appendEventId(ids: readonly string[], eventId: string): readonly string[] {
  const next = [...ids, eventId];
  return next.length > MAX_RECENT_EVENT_IDS
    ? next.slice(next.length - MAX_RECENT_EVENT_IDS)
    : next;
}

function acceptEvent(
  state: TerminalActivity,
  event: ActivityEvent,
  resetRun: boolean,
): TerminalActivity {
  return {
    ...state,
    generation: event.generation,
    runId: event.runId,
    lastSeq: event.seq,
    lastEventId: event.eventId,
    recentEventIds: resetRun
      ? [event.eventId]
      : appendEventId(state.recentEventIds, event.eventId),
    lastSource: event.source,
    updatedAt: Math.max(state.updatedAt, event.at),
  };
}

/**
 * Applies one validated bridge event. Rejected events return the original object so callers can
 * cheaply distinguish accepted transitions from duplicates or stale input.
 */
export function reduceTerminalActivity(
  state: TerminalActivity,
  event: ActivityEvent,
  context: ActivityReduceContext = { isAttended: false },
): TerminalActivity {
  if (!isWellFormedEvent(event)) return state;

  const isSpawnStart = event.source === "pty" && event.kind === "spawn-started";
  const startsNewRun = isSpawnStart && event.generation > state.generation;

  if (startsNewRun) {
    const next = acceptEvent(state, event, true);
    return {
      ...next,
      phase: "starting",
      reason: null,
      unread: false,
      armed: false,
      acknowledgedAt: null,
      exitCode: null,
    };
  }

  if (event.generation !== state.generation || event.runId !== state.runId) {
    return state;
  }
  if (event.seq <= state.lastSeq || state.recentEventIds.includes(event.eventId)) {
    return state;
  }

  // PTY exit is terminal for one generation. A hook watcher can drain slightly later than the
  // PTY channel, but that late hook must not resurrect an already-ended terminal.
  if (state.phase === "exited" && event.source === "hook") return state;

  const next = acceptEvent(state, event, false);

  switch (event.kind) {
    case "spawn-started":
      // A second spawn marker for the same run is metadata only; it must not erase live state.
      return next;
    case "spawn-ready":
      if (state.phase !== "starting") return next;
      return {
        ...next,
        phase: "idle",
        reason: null,
        exitCode: null,
      };
    case "spawn-failed":
      return {
        ...next,
        phase: "exited",
        reason: "spawn-error",
        unread:
          state.unread ||
          (state.terminalKind === "agent" && !context.isAttended),
        armed: false,
        exitCode: null,
      };
    case "process-exited": {
      const unexpectedAgentExit =
        state.terminalKind === "agent" &&
        !event.intentional &&
        !context.isAttended;
      return {
        ...next,
        phase: "exited",
        reason: "process-exit",
        unread: state.unread || unexpectedAgentExit,
        armed: false,
        exitCode: event.exitCode,
      };
    }
    case "prompt-submitted":
    case "work-resumed":
      if (state.terminalKind === "raw") return state;
      return {
        ...next,
        phase: "running",
        reason: null,
        unread: false,
        armed: true,
        acknowledgedAt: event.at,
        exitCode: null,
      };
    case "turn-completed":
      if (state.terminalKind === "raw") return state;
      // Stop/idle hooks can replay while a restored session settles. Accept their sequence so
      // older events cannot arrive later, but only create user-visible attention after a prompt
      // from this process generation armed the terminal.
      if (!state.armed) return next;
      return {
        ...next,
        phase: "waiting",
        reason: "turn-complete",
        unread: state.unread || !context.isAttended,
        armed: false,
        exitCode: null,
      };
    case "needs-permission":
    case "needs-input":
    case "agent-failed":
      if (state.terminalKind === "raw") return state;
      return {
        ...next,
        phase: "waiting",
        reason:
          event.kind === "needs-permission"
            ? "permission"
            : event.kind === "needs-input"
              ? "input"
              : "agent-failed",
        unread: state.unread || !context.isAttended,
        armed: event.kind === "agent-failed" ? false : state.armed,
        exitCode: null,
      };
  }
}

export function acknowledgeTerminalActivity(
  state: TerminalActivity,
  at = Date.now(),
): TerminalActivity {
  if (!state.unread) return state;
  return {
    ...state,
    unread: false,
    acknowledgedAt: Math.max(state.updatedAt, at),
  };
}

export type ActivityByTabId = Readonly<Record<string, TerminalActivity>>;

/** Acknowledges only the supplied leaves; activating a sibling pane must not clear its badge. */
export function acknowledgeTerminalActivities(
  activities: ActivityByTabId,
  tabIds: readonly string[],
  at = Date.now(),
): ActivityByTabId {
  const ids = new Set(tabIds);
  let changed = false;
  const next: Record<string, TerminalActivity> = { ...activities };

  for (const id of ids) {
    const current = activities[id];
    if (!current) continue;
    const acknowledged = acknowledgeTerminalActivity(current, at);
    if (acknowledged !== current) {
      next[id] = acknowledged;
      changed = true;
    }
  }

  return changed ? next : activities;
}

export const TERMINAL_ACTIVITY_SEVERITY: Readonly<
  Record<TerminalActivityPhase, number>
> = {
  idle: 10,
  starting: 20,
  running: 30,
  exited: 40,
  waiting: 50,
};

const REASON_SEVERITY: Readonly<Record<TerminalActivityReason, number>> = {
  "turn-complete": 10,
  "process-exit": 20,
  input: 30,
  permission: 40,
  "spawn-error": 50,
  "agent-failed": 60,
};

export interface TerminalActivityEntry {
  tabId: string;
  activity: TerminalActivity;
}

export interface TerminalActivityAggregate {
  total: number;
  phase: TerminalActivityPhase;
  reason: TerminalActivityReason | null;
  representativeTabId: string | null;
  unreadCount: number;
  phaseCounts: Readonly<Record<TerminalActivityPhase, number>>;
}

function outranks(
  candidate: TerminalActivityEntry,
  current: TerminalActivityEntry,
): boolean {
  const candidatePhase = TERMINAL_ACTIVITY_SEVERITY[candidate.activity.phase];
  const currentPhase = TERMINAL_ACTIVITY_SEVERITY[current.activity.phase];
  if (candidatePhase !== currentPhase) return candidatePhase > currentPhase;
  if (candidate.activity.unread !== current.activity.unread) {
    return candidate.activity.unread;
  }

  const candidateReason = candidate.activity.reason
    ? REASON_SEVERITY[candidate.activity.reason]
    : 0;
  const currentReason = current.activity.reason
    ? REASON_SEVERITY[current.activity.reason]
    : 0;
  if (candidateReason !== currentReason) return candidateReason > currentReason;
  if (candidate.activity.updatedAt !== current.activity.updatedAt) {
    return candidate.activity.updatedAt > current.activity.updatedAt;
  }
  return candidate.tabId.localeCompare(current.tabId) < 0;
}

export function aggregateTerminalActivities(
  entries: readonly TerminalActivityEntry[],
): TerminalActivityAggregate {
  const phaseCounts: Record<TerminalActivityPhase, number> = {
    starting: 0,
    idle: 0,
    running: 0,
    waiting: 0,
    exited: 0,
  };
  let representative: TerminalActivityEntry | null = null;
  let unreadCount = 0;

  for (const entry of entries) {
    phaseCounts[entry.activity.phase] += 1;
    if (entry.activity.unread) unreadCount += 1;
    if (!representative || outranks(entry, representative)) {
      representative = entry;
    }
  }

  return {
    total: entries.length,
    phase: representative?.activity.phase ?? "idle",
    reason: representative?.activity.reason ?? null,
    representativeTabId: representative?.tabId ?? null,
    unreadCount,
    phaseCounts,
  };
}

export interface AgentNotificationPreferences {
  enabled: boolean;
  onlyWhenWindowUnfocused: boolean;
  notifyOnTurnComplete: boolean;
  notifyOnNeedsInput: boolean;
  notifyOnFailure: boolean;
}

export const DEFAULT_AGENT_NOTIFICATION_PREFERENCES: AgentNotificationPreferences = {
  enabled: false,
  onlyWhenWindowUnfocused: true,
  notifyOnTurnComplete: true,
  notifyOnNeedsInput: true,
  notifyOnFailure: true,
};

export function sanitizeAgentNotificationPreferences(
  value: unknown,
): AgentNotificationPreferences {
  const source =
    value && typeof value === "object"
      ? (value as Partial<AgentNotificationPreferences>)
      : {};
  const defaults = DEFAULT_AGENT_NOTIFICATION_PREFERENCES;
  return {
    enabled:
      typeof source.enabled === "boolean" ? source.enabled : defaults.enabled,
    onlyWhenWindowUnfocused:
      typeof source.onlyWhenWindowUnfocused === "boolean"
        ? source.onlyWhenWindowUnfocused
        : defaults.onlyWhenWindowUnfocused,
    notifyOnTurnComplete:
      typeof source.notifyOnTurnComplete === "boolean"
        ? source.notifyOnTurnComplete
        : defaults.notifyOnTurnComplete,
    notifyOnNeedsInput:
      typeof source.notifyOnNeedsInput === "boolean"
        ? source.notifyOnNeedsInput
        : defaults.notifyOnNeedsInput,
    notifyOnFailure:
      typeof source.notifyOnFailure === "boolean"
        ? source.notifyOnFailure
        : defaults.notifyOnFailure,
  };
}

export interface AgentNotificationContext {
  nativePermissionGranted: boolean;
  notificationsReady: boolean;
  isWindowFocused: boolean;
  isTargetVisible: boolean;
}

export type NotificationSuppressionReason =
  | "send"
  | "duplicate-or-stale"
  | "disabled"
  | "permission-denied"
  | "startup"
  | "raw-shell"
  | "attended"
  | "window-focused"
  | "unarmed"
  | "event-disabled"
  | "intentional-close"
  | "not-notifiable"
  | "not-unread";

/**
 * Decides whether an already-reduced event should create a native notification. The caller must
 * pass the same focus/visibility snapshot used to reduce the event.
 */
export function notificationDecision(
  previous: TerminalActivity,
  next: TerminalActivity,
  event: ActivityEvent,
  preferences: AgentNotificationPreferences,
  context: AgentNotificationContext,
): NotificationSuppressionReason {
  if (next === previous || next.lastEventId !== event.eventId) {
    return "duplicate-or-stale";
  }
  if (
    previous.unread &&
    next.unread &&
    previous.reason !== null &&
    previous.reason === next.reason
  ) {
    return "duplicate-or-stale";
  }
  if (previous.terminalKind === "raw") return "raw-shell";
  if (!preferences.enabled) return "disabled";
  if (!context.nativePermissionGranted) return "permission-denied";
  if (!context.notificationsReady) return "startup";
  if (context.isWindowFocused && context.isTargetVisible) return "attended";
  if (preferences.onlyWhenWindowUnfocused && context.isWindowFocused) {
    return "window-focused";
  }

  switch (event.kind) {
    case "turn-completed":
      if (!previous.armed) return "unarmed";
      if (!preferences.notifyOnTurnComplete) return "event-disabled";
      break;
    case "needs-permission":
    case "needs-input":
      if (!preferences.notifyOnNeedsInput) return "event-disabled";
      break;
    case "agent-failed":
    case "spawn-failed":
      if (!preferences.notifyOnFailure) return "event-disabled";
      break;
    case "process-exited":
      if (event.intentional) return "intentional-close";
      if (!preferences.notifyOnFailure) return "event-disabled";
      break;
    default:
      return "not-notifiable";
  }

  return next.unread ? "send" : "not-unread";
}
