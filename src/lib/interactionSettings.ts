import {
  DIGIT_KEY_TEMPLATE,
  cloneKeyChord,
  findKeybindingConflicts,
  keyChordId,
  sanitizeKeyChord,
  type KeyChord,
  type KeybindingConflict,
} from "./keybindings";

export const INTERACTION_SETTINGS_VERSION = 1 as const;

export type KeybindingPlatform = "windows" | "macos" | "linux";
export type TerminalMouseAction = "selection-or-clipboard-paste" | "paste-clipboard" | "copy-selection" | "context-menu" | "none";
export type TerminalMouseEventPhase = "mousedown" | "auxclick" | "contextmenu";
export type TerminalMouseEventDisposition = "pass" | "consume" | "perform";
export type EditorPreset = "system" | "visual-studio-code" | "cursor";

export interface InteractionSettings {
  version: typeof INTERACTION_SETTINGS_VERSION;
  quickActions: KeyChord;
  quickSwitch: KeyChord;
  terminalSearch: KeyChord;
  reopenClosed: KeyChord;
  terminalCopy: KeyChord[];
  terminalPaste: KeyChord[];
  copyOnSelect: boolean;
  copyCtrlCWhenSelected: boolean;
  middleClick: TerminalMouseAction;
  rightClick: TerminalMouseAction;
  fileLinksEnabled: boolean;
  editorPreset: EditorPreset;
}

const MOUSE_ACTIONS = new Set<TerminalMouseAction>([
  "selection-or-clipboard-paste", "paste-clipboard", "copy-selection", "context-menu", "none",
]);

const EDITOR_PRESETS = new Set<EditorPreset>(["system", "visual-studio-code", "cursor"]);

/** Keeps browser mouse event phases from performing one configured action more than once. */
export function terminalMouseEventDisposition(
  button: number,
  phase: TerminalMouseEventPhase,
  action: TerminalMouseAction,
): TerminalMouseEventDisposition {
  if (action === "none") return "pass";
  if (button === 1) {
    if (phase === "mousedown") return "perform";
    return phase === "auxclick" ? "consume" : "pass";
  }
  if (button === 2) {
    if (phase === "mousedown") return "consume";
    return phase === "contextmenu" ? "perform" : "pass";
  }
  return "pass";
}

export function shouldRefocusTerminalAfterMouseAction(action: TerminalMouseAction): boolean {
  return action !== "context-menu";
}

function chord(code: string, modifiers: Partial<Omit<KeyChord, "code">> = {}): KeyChord {
  return { code, ctrl: false, alt: false, shift: false, meta: false, ...modifiers };
}

export function detectKeybindingPlatform(userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent): KeybindingPlatform {
  const ua = userAgent.toLowerCase();
  if (ua.includes("mac") || ua.includes("iphone") || ua.includes("ipad")) return "macos";
  if (ua.includes("win")) return "windows";
  return "linux";
}

export function getDefaultInteractionSettings(platform: KeybindingPlatform = detectKeybindingPlatform()): InteractionSettings {
  const mac = platform === "macos";
  return {
    version: INTERACTION_SETTINGS_VERSION,
    quickActions: chord("KeyK", mac ? { meta: true } : { ctrl: true }),
    quickSwitch: chord(DIGIT_KEY_TEMPLATE, { alt: true }),
    terminalSearch: chord("KeyF", mac ? { meta: true } : { ctrl: true }),
    reopenClosed: chord("KeyT", mac ? { meta: true, shift: true } : { ctrl: true, shift: true }),
    terminalCopy: [chord("KeyC", mac ? { meta: true } : { ctrl: true, shift: true })],
    terminalPaste: mac
      ? [chord("KeyV", { meta: true }), chord("Insert", { shift: true })]
      : [chord("KeyV", { ctrl: true }), chord("KeyV", { ctrl: true, shift: true }), chord("Insert", { shift: true })],
    copyOnSelect: false,
    copyCtrlCWhenSelected: true,
    middleClick: "selection-or-clipboard-paste",
    rightClick: "context-menu",
    fileLinksEnabled: true,
    editorPreset: "system",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function sanitizeMouseAction(value: unknown, fallback: TerminalMouseAction): TerminalMouseAction {
  return typeof value === "string" && MOUSE_ACTIONS.has(value as TerminalMouseAction)
    ? value as TerminalMouseAction
    : fallback;
}

function sanitizeEditorPreset(value: unknown, fallback: EditorPreset): EditorPreset {
  return typeof value === "string" && EDITOR_PRESETS.has(value as EditorPreset)
    ? value as EditorPreset
    : fallback;
}

function sanitizeChordArray(value: unknown, fallback: readonly KeyChord[]): KeyChord[] {
  if (!Array.isArray(value)) return fallback.map(cloneKeyChord);
  const seen = new Set<string>();
  const sanitized: KeyChord[] = [];
  for (const candidate of value.slice(0, 8)) {
    const parsed = sanitizeKeyChord(candidate);
    if (!parsed) continue;
    const id = keyChordId(parsed);
    if (seen.has(id)) continue;
    seen.add(id);
    sanitized.push(parsed);
  }
  return sanitized.length > 0 ? sanitized : fallback.map(cloneKeyChord);
}

/**
 * Sanitizes every setting independently. A corrupt field cannot discard valid siblings, and
 * missing/unknown schema versions migrate to the current shape using platform defaults.
 */
export function sanitizeInteractionSettings(
  value: unknown,
  platform: KeybindingPlatform = detectKeybindingPlatform(),
): InteractionSettings {
  const defaults = getDefaultInteractionSettings(platform);
  if (!isRecord(value)) return defaults;

  const quickActions = sanitizeKeyChord(value.quickActions);
  const quickSwitch = sanitizeKeyChord(value.quickSwitch, { allowDigitTemplate: true });
  const terminalSearch = sanitizeKeyChord(value.terminalSearch);
  const reopenClosed = sanitizeKeyChord(value.reopenClosed);
  return {
    version: INTERACTION_SETTINGS_VERSION,
    quickActions: quickActions ?? cloneKeyChord(defaults.quickActions),
    quickSwitch: quickSwitch?.code === DIGIT_KEY_TEMPLATE ? quickSwitch : cloneKeyChord(defaults.quickSwitch),
    terminalSearch: terminalSearch ?? cloneKeyChord(defaults.terminalSearch),
    reopenClosed: reopenClosed ?? cloneKeyChord(defaults.reopenClosed),
    terminalCopy: sanitizeChordArray(value.terminalCopy, defaults.terminalCopy),
    terminalPaste: sanitizeChordArray(value.terminalPaste, defaults.terminalPaste),
    copyOnSelect: sanitizeBoolean(value.copyOnSelect, defaults.copyOnSelect),
    copyCtrlCWhenSelected: sanitizeBoolean(value.copyCtrlCWhenSelected, defaults.copyCtrlCWhenSelected),
    middleClick: sanitizeMouseAction(value.middleClick, defaults.middleClick),
    rightClick: sanitizeMouseAction(value.rightClick, defaults.rightClick),
    fileLinksEnabled: sanitizeBoolean(value.fileLinksEnabled, defaults.fileLinksEnabled),
    editorPreset: sanitizeEditorPreset(value.editorPreset, defaults.editorPreset),
  };
}

export function cloneInteractionSettings(settings: InteractionSettings): InteractionSettings {
  return {
    ...settings,
    quickActions: cloneKeyChord(settings.quickActions),
    quickSwitch: cloneKeyChord(settings.quickSwitch),
    terminalSearch: cloneKeyChord(settings.terminalSearch),
    reopenClosed: cloneKeyChord(settings.reopenClosed),
    terminalCopy: settings.terminalCopy.map(cloneKeyChord),
    terminalPaste: settings.terminalPaste.map(cloneKeyChord),
  };
}

export function findInteractionSettingConflicts(settings: InteractionSettings): KeybindingConflict[] {
  return findKeybindingConflicts({
    quickActions: settings.quickActions,
    quickSwitch: settings.quickSwitch,
    terminalSearch: settings.terminalSearch,
    reopenClosed: settings.reopenClosed,
    terminalCopy: settings.terminalCopy,
    terminalPaste: settings.terminalPaste,
  });
}
