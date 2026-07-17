import { describe, expect, it } from "vitest";
import {
  acknowledgeTerminalActivities,
  acknowledgeTerminalActivity,
  aggregateTerminalActivities,
  createTerminalActivity,
  notificationDecision,
  sanitizeAgentNotificationPreferences,
  reduceTerminalActivity,
  type ActivityEvent,
  type AgentNotificationContext,
  type AgentNotificationPreferences,
  type HookActivityEvent,
  type PtyActivityEvent,
  type TerminalActivity,
} from "./terminalActivity";

const RUN = "run-1";

function pty(
  kind: PtyActivityEvent["kind"],
  seq: number,
  extra: Partial<PtyActivityEvent> = {},
): PtyActivityEvent {
  return {
    source: "pty",
    kind,
    eventId: `${RUN}:pty:${kind}:${seq}`,
    generation: 1,
    runId: RUN,
    seq,
    at: seq * 10,
    ...(extra as object),
  } as PtyActivityEvent;
}

function hook(
  kind: HookActivityEvent["kind"],
  seq: number,
  extra: Partial<HookActivityEvent> = {},
): HookActivityEvent {
  return {
    source: "hook",
    kind,
    eventId: `${RUN}:hook:${kind}:${seq}`,
    generation: 1,
    runId: RUN,
    seq,
    at: seq * 10,
    ...(extra as object),
  } as HookActivityEvent;
}

function started(kind: "agent" | "raw" = "agent"): TerminalActivity {
  return reduceTerminalActivity(
    createTerminalActivity(kind),
    pty("spawn-started", 1),
  );
}

function running(): TerminalActivity {
  const ready = reduceTerminalActivity(started(), pty("spawn-ready", 2));
  return reduceTerminalActivity(ready, hook("prompt-submitted", 3));
}

const preferences: AgentNotificationPreferences = {
  enabled: true,
  onlyWhenWindowUnfocused: true,
  notifyOnTurnComplete: true,
  notifyOnNeedsInput: true,
  notifyOnFailure: true,
};

const backgroundContext: AgentNotificationContext = {
  nativePermissionGranted: true,
  notificationsReady: true,
  isWindowFocused: false,
  isTargetVisible: false,
};

describe("reduceTerminalActivity", () => {
  it("tracks an authoritative prompt-to-completion lifecycle", () => {
    const spawning = started();
    expect(spawning).toMatchObject({ phase: "starting", armed: false });

    const ready = reduceTerminalActivity(spawning, pty("spawn-ready", 2));
    expect(ready).toMatchObject({ phase: "idle", unread: false });

    const active = reduceTerminalActivity(ready, hook("prompt-submitted", 3));
    expect(active).toMatchObject({ phase: "running", armed: true });

    const completeEvent = hook("turn-completed", 4);
    const complete = reduceTerminalActivity(active, completeEvent);
    expect(complete).toMatchObject({
      phase: "waiting",
      reason: "turn-complete",
      unread: true,
      armed: false,
    });
    expect(
      notificationDecision(
        active,
        complete,
        completeEvent,
        preferences,
        backgroundContext,
      ),
    ).toBe("send");

    const acknowledged = acknowledgeTerminalActivity(complete, 50);
    expect(acknowledged).toMatchObject({
      phase: "waiting",
      unread: false,
      acknowledgedAt: 50,
    });

    // A second completion-like hook cannot re-alert until another prompt arms the run.
    const duplicateSemanticEvent = hook("turn-completed", 5);
    const stillAcknowledged = reduceTerminalActivity(
      acknowledged,
      duplicateSemanticEvent,
    );
    expect(stillAcknowledged).toMatchObject({
      phase: "waiting",
      unread: false,
      armed: false,
      lastSeq: 5,
    });
    expect(
      notificationDecision(
        acknowledged,
        stillAcknowledged,
        duplicateSemanticEvent,
        preferences,
        backgroundContext,
      ),
    ).toBe("unarmed");
  });

  it("rejects stale sequences, duplicate ids, wrong runs, and old generations", () => {
    const state = running();

    expect(reduceTerminalActivity(state, hook("needs-input", 3))).toBe(state);
    expect(
      reduceTerminalActivity(
        state,
        hook("needs-input", 4, { eventId: state.lastEventId! }),
      ),
    ).toBe(state);
    expect(
      reduceTerminalActivity(
        state,
        hook("needs-input", 4, { runId: "wrong-run" }),
      ),
    ).toBe(state);
    expect(
      reduceTerminalActivity(
        state,
        hook("needs-input", 4, { generation: 0 }),
      ),
    ).toBe(state);

    const nextRun = pty("spawn-started", 0, {
      generation: 2,
      runId: "run-2",
      eventId: "run-2:start",
      at: 100,
    });
    const reset = reduceTerminalActivity(state, nextRun);
    expect(reset).toMatchObject({
      generation: 2,
      runId: "run-2",
      lastSeq: 0,
      phase: "starting",
      armed: false,
      unread: false,
    });
    expect(reduceTerminalActivity(reset, hook("needs-input", 99))).toBe(reset);
  });

  it("runtime-rejects semantic events from the wrong source", () => {
    const state = started();
    const forged = {
      ...hook("turn-completed", 2),
      source: "pty",
    } as unknown as ActivityEvent;
    expect(reduceTerminalActivity(state, forged)).toBe(state);
  });

  it("does not create unread attention for the attended leaf", () => {
    const active = running();
    const event = hook("turn-completed", 4);
    const next = reduceTerminalActivity(active, event, { isAttended: true });

    expect(next).toMatchObject({
      phase: "waiting",
      reason: "turn-complete",
      unread: false,
    });
    expect(
      notificationDecision(active, next, event, preferences, {
        ...backgroundContext,
        isWindowFocused: true,
        isTargetVisible: true,
      }),
    ).toBe("attended");
  });

  it("keeps raw shells out of hook semantics while preserving real exits", () => {
    const raw = reduceTerminalActivity(started("raw"), pty("spawn-ready", 2));
    expect(reduceTerminalActivity(raw, hook("prompt-submitted", 3))).toBe(raw);

    const exit = pty("process-exited", 3, { exitCode: 17 });
    const exited = reduceTerminalActivity(raw, exit);
    expect(exited).toMatchObject({
      phase: "exited",
      reason: "process-exit",
      exitCode: 17,
      unread: false,
    });
    expect(
      notificationDecision(raw, exited, exit, preferences, backgroundContext),
    ).toBe("raw-shell");
  });

  it("records intentional close without unread attention or a notification", () => {
    const active = running();
    const exit = pty("process-exited", 4, {
      exitCode: 0,
      intentional: true,
    });
    const exited = reduceTerminalActivity(active, exit);

    expect(exited).toMatchObject({ phase: "exited", unread: false, exitCode: 0 });
    expect(
      notificationDecision(active, exited, exit, preferences, backgroundContext),
    ).toBe("intentional-close");
  });

  it("does not downgrade running or resurrect an exited generation", () => {
    const active = running();
    const delayedReady = pty("spawn-ready", 4);
    const stillRunning = reduceTerminalActivity(active, delayedReady);
    expect(stillRunning).toMatchObject({ phase: "running", armed: true });

    const exited = reduceTerminalActivity(
      stillRunning,
      pty("process-exited", 5, { exitCode: 1 }),
    );
    expect(reduceTerminalActivity(exited, hook("needs-input", 6))).toBe(exited);
  });
});

describe("acknowledgeTerminalActivities", () => {
  it("acknowledges only the exact selected group leaf", () => {
    const base = running();
    const first = reduceTerminalActivity(base, hook("needs-input", 4));
    const second = reduceTerminalActivity(base, hook("needs-permission", 4));
    const activities = { first, second };

    const next = acknowledgeTerminalActivities(activities, ["first"], 60);
    expect(next.first.unread).toBe(false);
    expect(next.second.unread).toBe(true);
    expect(next.second).toBe(second);
    expect(acknowledgeTerminalActivities(next, ["missing"], 70)).toBe(next);
  });
});

describe("aggregateTerminalActivities", () => {
  it("uses waiting > exited > running > starting > idle and counts unread leaves", () => {
    const idle = reduceTerminalActivity(started(), pty("spawn-ready", 2));
    const active = running();
    const exited = reduceTerminalActivity(
      active,
      pty("process-exited", 4, { exitCode: 1 }),
    );
    const waiting = reduceTerminalActivity(
      active,
      hook("needs-permission", 4),
    );

    const aggregate = aggregateTerminalActivities([
      { tabId: "idle", activity: idle },
      { tabId: "running", activity: active },
      { tabId: "exited", activity: exited },
      { tabId: "waiting", activity: waiting },
    ]);

    expect(aggregate).toMatchObject({
      total: 4,
      phase: "waiting",
      reason: "permission",
      representativeTabId: "waiting",
      unreadCount: 2,
      phaseCounts: { idle: 1, running: 1, exited: 1, waiting: 1 },
    });
  });

  it("breaks equal-severity ties deterministically", () => {
    const base = running();
    const a = reduceTerminalActivity(
      base,
      hook("needs-input", 4, { at: 100 }),
    );
    const b = reduceTerminalActivity(
      base,
      hook("needs-input", 4, { at: 100, eventId: "other" }),
    );
    const firstOrder = aggregateTerminalActivities([
      { tabId: "b", activity: b },
      { tabId: "a", activity: a },
    ]);
    const reverseOrder = aggregateTerminalActivities([
      { tabId: "a", activity: a },
      { tabId: "b", activity: b },
    ]);
    expect(firstOrder.representativeTabId).toBe("a");
    expect(reverseOrder.representativeTabId).toBe("a");
  });
});

describe("notificationDecision", () => {
  it("suppresses completion before a prompt arms the process", () => {
    const ready = reduceTerminalActivity(started(), pty("spawn-ready", 2));
    const event = hook("turn-completed", 3);
    const next = reduceTerminalActivity(ready, event);

    expect(next).toMatchObject({ phase: "idle", unread: false, armed: false });
    expect(
      notificationDecision(ready, next, event, preferences, backgroundContext),
    ).toBe("unarmed");
  });

  it("honors permission, startup, focus, and per-event settings", () => {
    const active = running();
    const event = hook("needs-permission", 4);
    const next = reduceTerminalActivity(active, event);

    expect(
      notificationDecision(active, next, event, preferences, {
        ...backgroundContext,
        nativePermissionGranted: false,
      }),
    ).toBe("permission-denied");
    expect(
      notificationDecision(active, next, event, preferences, {
        ...backgroundContext,
        notificationsReady: false,
      }),
    ).toBe("startup");
    expect(
      notificationDecision(active, next, event, preferences, {
        ...backgroundContext,
        isWindowFocused: true,
      }),
    ).toBe("window-focused");
    expect(
      notificationDecision(
        active,
        next,
        event,
        { ...preferences, notifyOnNeedsInput: false },
        backgroundContext,
      ),
    ).toBe("event-disabled");
  });

  it("never notifies twice for a duplicate event", () => {
    const active = running();
    const event = hook("turn-completed", 4);
    const complete = reduceTerminalActivity(active, event);
    const duplicate = reduceTerminalActivity(complete, event);

    expect(duplicate).toBe(complete);
    expect(
      notificationDecision(
        complete,
        duplicate,
        event,
        preferences,
        backgroundContext,
      ),
    ).toBe("duplicate-or-stale");
  });

  it("does not notify twice for distinct hooks describing one outstanding permission", () => {
    const active = running();
    const firstEvent = hook("needs-permission", 4);
    const first = reduceTerminalActivity(active, firstEvent);
    const secondEvent = hook("needs-permission", 5, {
      eventId: `${RUN}:hook:notification-permission:5`,
    });
    const second = reduceTerminalActivity(first, secondEvent);

    expect(second.lastEventId).toBe(secondEvent.eventId);
    expect(
      notificationDecision(first, second, secondEvent, preferences, backgroundContext),
    ).toBe("duplicate-or-stale");

    const acknowledged = acknowledgeTerminalActivity(first, 45);
    const later = reduceTerminalActivity(acknowledged, secondEvent);
    expect(
      notificationDecision(acknowledged, later, secondEvent, preferences, backgroundContext),
    ).toBe("send");
  });

  it("does not treat normal lifecycle events as notification events", () => {
    const state = createTerminalActivity("agent");
    const event = pty("spawn-started", 1);
    const next = reduceTerminalActivity(state, event);
    expect(
      notificationDecision(state, next, event, preferences, backgroundContext),
    ).toBe("not-notifiable");
  });
});

describe("sanitizeAgentNotificationPreferences", () => {
  it("defaults to disabled and sanitizes malformed fields independently", () => {
    expect(sanitizeAgentNotificationPreferences(null)).toEqual({
      enabled: false,
      onlyWhenWindowUnfocused: true,
      notifyOnTurnComplete: true,
      notifyOnNeedsInput: true,
      notifyOnFailure: true,
    });
    expect(
      sanitizeAgentNotificationPreferences({
        enabled: true,
        onlyWhenWindowUnfocused: "no",
        notifyOnTurnComplete: false,
        notifyOnNeedsInput: 1,
        notifyOnFailure: false,
      }),
    ).toEqual({
      enabled: true,
      onlyWhenWindowUnfocused: true,
      notifyOnTurnComplete: false,
      notifyOnNeedsInput: true,
      notifyOnFailure: false,
    });
  });
});
