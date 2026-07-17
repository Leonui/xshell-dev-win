# First Batch Implementation Contract

This document defines the acceptance criteria for the first feature batch. A feature is not
complete until its behavior, persistence, tests, and packaged Windows build pass the hard gate.

## 1. Configurable Input

- Persist one versioned interaction-settings object and sanitize malformed values field by field.
- Key chords use `KeyboardEvent.code` plus exact modifiers so keyboard layout changes do not
  silently change a binding.
- Users can change Quick Actions, terminal search, reopen closed, terminal copy, terminal paste,
  and the modifier used by visible-position tab switching.
- Reject bare printable bindings and report conflicts before saving.
- Ignore AltGr, IME composition, repeats where unsafe, and shortcuts typed into editable fields or
  an active modal/key recorder.
- Binding changes apply to already-running terminals without recreating xterm or its PTY.
- Mouse settings cover copy-on-select and configurable middle/right-click actions. Consumed mouse
  actions never leak a duplicate mouse event into a terminal application.
- Shortcut labels in menus and tooltips are derived from the active configuration.

## 2. Terminal Search And File References

- Each terminal owns a SearchAddon-backed search overlay with incremental highlighting, next and
  previous navigation, case-sensitive and regex toggles, current/total results, and honest invalid
  regex/no-result states.
- Search controls consume their keys instead of sending them to the PTY. Escape clears decorations,
  closes the overlay, and restores terminal focus.
- A custom xterm link provider recognizes Windows drive paths, UNC paths, POSIX absolute paths,
  `./`, `../`, and project-relative file references with optional line and column numbers.
- HTTP(S) links keep using the system browser and take precedence over file links.
- Relative file references resolve against the tab project root. Post-`cd` cwd tracking is outside
  this batch and must not be claimed.
- Editor launching uses a fixed preset and structured process arguments. Terminal output is never
  interpolated into a shell command. Missing files and unsupported editors produce visible errors.

## 3. Agent Activity And Notifications

- Live activity is separate from persisted tab metadata. Phases are starting, idle, running,
  waiting, and exited; unread attention is tracked independently.
- Authoritative provider lifecycle events drive completion/needs-input notifications. PTY output,
  silence, resize, and BEL alone never claim an agent turn completed.
- Claude and Codex lifecycle integrations are opt-in, idempotent, preserve unrelated user config,
  validate hook payloads, and degrade safely when unavailable. Other providers expose only states
  supported by reliable lifecycle evidence.
- A prompt submitted in the current xshell process arms completion. Restored/eager sessions do not
  emit startup completion notifications.
- Active focused leaves do not create OS notifications. Background completion/needs-input creates
  one unread indicator and at most one privacy-safe notification.
- Selecting the exact leaf acknowledges unread state. Group entries aggregate severity and unread
  leaf count deterministically.
- Notification permission is requested only from an explicit user action. Denial or plugin failure
  leaves tab indicators functional.
- Windows receives a taskbar attention overlay while unread attention exists and clears it at zero.

## 4. Pinned And Closed Tabs

- Pinning is entry-level: standalone tabs and complete groups can be pinned. Every close path,
  including pane close and Quick Actions, protects pinned entries until they are unpinned.
- Pinned entries occupy a stable left partition while preserving order inside each partition.
- Right-click opens a tab/group menu with Rename, Pin/Unpin, and Close. Double-click rename remains.
- Reopen Closed uses a configurable shortcut and Quick Actions entry.
- Closed history is a capped session-only LIFO containing standalone tabs, whole groups, and pane
  closures. Restoration allocates fresh runtime IDs and restores group layout ratios and active leaf.
- Pinned entries always restore on app startup. A setting controls restoration of unpinned entries.

## 5. Saved Workspaces And Launch Recipes

- Window state is persisted atomically as one versioned record containing ordered entries, groups,
  active entry, and active group leaves. Legacy split tab/group data is migrated defensively.
- Workspace snapshots use snapshot-local keys, never live tab IDs. Restore remaps every layout leaf
  to fresh runtime IDs and preserves order, ratios, custom titles, pins, sessions, and active leaf.
- Workspace load supports Replace and Merge. Replace refuses to discard conflicting pinned entries;
  Merge skips duplicate agent/session IDs and reports skipped entries.
- Quick Actions exposes Save Workspace, Open Workspace, Run Recipe, and Reopen Closed.
- Settings provides workspace/recipe rename, duplicate, delete, edit, open/run controls.
- Recipes are versioned, ordered, and preflighted before mutation. Steps support agents, shells, and
  commands with project/home/absolute cwd, environment variables, and tab or split layouts.
- Command launch uses structured launch specifications. Reserved xshell environment variables cannot
  be overridden. Persisted/imported commands do not auto-run at startup without explicit trust.

## Hard Gate

All items below are mandatory:

1. Frontend unit/component tests cover settings migration and conflicts, key dispatch, mouse modes,
   search behavior, file parsing/ranges, activity reduction/deduplication, pinned close/undo, exact
   group restoration, workspace remapping/migration, and recipe validation/atomicity.
2. Rust unit tests cover editor path resolution/arguments, safe command launch specifications,
   activity-hook payload validation, config merge idempotency, and reserved environment handling.
3. `npm test -- --run` passes.
4. `npm run build` passes.
5. `cargo fmt --check`, `cargo test`, and warning-denied `cargo clippy` pass for `src-tauri`.
6. A signed Windows release build produces the portable EXE, MSI, NSIS installer, and both updater
   signature files.
7. Independent subagents inspect implementation and test coverage. No unresolved critical or high
   severity findings may remain.
8. Packaged Windows smoke testing covers notification permission/test toast, background activity,
   taskbar attention clearing, grouped-leaf acknowledgement, remapped shortcuts, AltGr, mouse modes,
   literal/regex search, browser URLs, safe absolute/relative file opening, pin/close/undo, workspace
   Replace/Merge, and recipe preflight/run.
