export const DIGIT_KEY_TEMPLATE = "Digit#" as const;

export interface KeyChord {
  code: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface KeyEventLike {
  code: string;
  key?: string;
  keyCode?: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  target?: EventTarget | null;
  getModifierState?(key: string): boolean;
}

export interface KeyMatchOptions {
  allowRepeat?: boolean;
  allowComposing?: boolean;
  allowAltGraph?: boolean;
}

export interface KeyChordSanitizeOptions {
  allowDigitTemplate?: boolean;
}

export type KeybindingCollection = Record<string, KeyChord | readonly KeyChord[] | null | undefined>;

export interface KeybindingConflict {
  firstId: string;
  firstIndex: number;
  secondId: string;
  secondIndex: number;
}

const MODIFIER_CODES = new Set([
  "AltLeft", "AltRight", "ControlLeft", "ControlRight", "MetaLeft", "MetaRight", "ShiftLeft", "ShiftRight",
]);

const NON_PRINTABLE_CODES = new Set([
  "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "Backspace", "Delete", "End", "Enter", "Escape",
  "Home", "Insert", "PageDown", "PageUp", "Tab",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSupportedCode(code: string, allowDigitTemplate: boolean): boolean {
  if (allowDigitTemplate && code === DIGIT_KEY_TEMPLATE) return true;
  if (MODIFIER_CODES.has(code)) return false;
  if (NON_PRINTABLE_CODES.has(code)) return true;
  if (/^F(?:[1-9]|1\d|2[0-4])$/.test(code)) return true;
  return /^(?:Key[A-Z]|Digit[0-9]|Numpad(?:[0-9]|Add|Comma|Decimal|Divide|Enter|Equal|Multiply|Subtract)|Space)$/.test(code);
}

/** Bare printable keys (including Shift+letter/digit) are unsafe as global shortcuts. */
export function isSafeKeyChord(chord: KeyChord, options: KeyChordSanitizeOptions = {}): boolean {
  if (!isSupportedCode(chord.code, options.allowDigitTemplate === true)) return false;
  if (chord.code === DIGIT_KEY_TEMPLATE && !(chord.ctrl || chord.alt || chord.meta)) return false;

  const printable = /^(?:Key[A-Z]|Digit[0-9]|Numpad|Space)/.test(chord.code);
  return !printable || chord.ctrl || chord.alt || chord.meta;
}

export function sanitizeKeyChord(value: unknown, options: KeyChordSanitizeOptions = {}): KeyChord | null {
  if (!isRecord(value) || typeof value.code !== "string") return null;
  const code = value.code.trim();
  if (!code || code.length > 32) return null;
  const chord: KeyChord = {
    code,
    ctrl: typeof value.ctrl === "boolean" ? value.ctrl : false,
    alt: typeof value.alt === "boolean" ? value.alt : false,
    shift: typeof value.shift === "boolean" ? value.shift : false,
    meta: typeof value.meta === "boolean" ? value.meta : false,
  };
  return isSafeKeyChord(chord, options) ? chord : null;
}

export function cloneKeyChord(chord: KeyChord): KeyChord {
  return { ...chord };
}

export function keyChordId(chord: KeyChord): string {
  return `${chord.ctrl ? "C" : "-"}${chord.alt ? "A" : "-"}${chord.shift ? "S" : "-"}${chord.meta ? "M" : "-"}:${chord.code}`;
}

export function isAltGraphEvent(event: KeyEventLike): boolean {
  try {
    return event.getModifierState?.("AltGraph") === true;
  } catch {
    return false;
  }
}

export function shouldIgnoreKeyEvent(event: KeyEventLike, options: KeyMatchOptions = {}): boolean {
  if (!options.allowRepeat && event.repeat) return true;
  if (!options.allowComposing && (event.isComposing || event.keyCode === 229)) return true;
  if (!options.allowAltGraph && isAltGraphEvent(event)) return true;
  return false;
}

function modifiersMatch(event: KeyEventLike, chord: KeyChord): boolean {
  return event.ctrlKey === chord.ctrl
    && event.altKey === chord.alt
    && event.shiftKey === chord.shift
    && event.metaKey === chord.meta;
}

export function matchesKeyChord(event: KeyEventLike, chord: KeyChord, options: KeyMatchOptions = {}): boolean {
  if (chord.code === DIGIT_KEY_TEMPLATE || shouldIgnoreKeyEvent(event, options)) return false;
  return event.code === chord.code && modifiersMatch(event, chord);
}

/** Returns the 1-based quick-switch slot, or null when the digit template does not match. */
export function matchDigitKeyChord(event: KeyEventLike, chord: KeyChord, options: KeyMatchOptions = {}): number | null {
  if (chord.code !== DIGIT_KEY_TEMPLATE || shouldIgnoreKeyEvent(event, options) || !modifiersMatch(event, chord)) return null;
  const match = /^Digit([1-9])$/.exec(event.code);
  return match ? Number(match[1]) : null;
}

function chordsOverlap(a: KeyChord, b: KeyChord): boolean {
  if (a.ctrl !== b.ctrl || a.alt !== b.alt || a.shift !== b.shift || a.meta !== b.meta) return false;
  if (a.code === b.code) return true;
  if (a.code === DIGIT_KEY_TEMPLATE) return /^Digit[1-9]$/.test(b.code);
  if (b.code === DIGIT_KEY_TEMPLATE) return /^Digit[1-9]$/.test(a.code);
  return false;
}

export function findKeybindingConflicts(bindings: KeybindingCollection): KeybindingConflict[] {
  const entries: Array<{ id: string; index: number; chord: KeyChord }> = [];
  for (const [id, value] of Object.entries(bindings)) {
    const chords = Array.isArray(value) ? value : value ? [value] : [];
    chords.forEach((chord, index) => entries.push({ id, index, chord }));
  }

  const conflicts: KeybindingConflict[] = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (!chordsOverlap(entries[i].chord, entries[j].chord)) continue;
      conflicts.push({
        firstId: entries[i].id,
        firstIndex: entries[i].index,
        secondId: entries[j].id,
        secondIndex: entries[j].index,
      });
    }
  }
  return conflicts;
}

export function isEditableShortcutTarget(target: EventTarget | null | undefined): boolean {
  if (!target || typeof target !== "object") return false;
  const candidate = target as EventTarget & {
    tagName?: string;
    isContentEditable?: boolean;
    closest?: (selector: string) => Element | null;
  };
  if (candidate.isContentEditable) return true;
  if (typeof candidate.closest === "function") {
    // xterm routes terminal keystrokes through its hidden textarea. Treating it like a
    // form field disables app-wide shortcuts precisely while the terminal is focused.
    if (candidate.closest(".xterm-helper-textarea")) return false;
    return candidate.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;
  }
  return ["INPUT", "TEXTAREA", "SELECT"].includes(candidate.tagName?.toUpperCase() ?? "");
}

/** Global shortcuts should use this; terminal-local handlers must not reject xterm's textarea. */
export function shouldIgnoreGlobalShortcut(event: KeyEventLike, options: KeyMatchOptions = {}): boolean {
  const recorderActive = typeof document !== "undefined"
    && document.documentElement.dataset.keybindingRecording === "true";
  const modalActive = typeof document !== "undefined"
    && document.querySelector('[aria-modal="true"]') !== null;
  return recorderActive || modalActive || shouldIgnoreKeyEvent(event, options) || isEditableShortcutTarget(event.target);
}

export function formatKeyChord(chord: KeyChord, platform: "windows" | "macos" | "linux" = "windows"): string {
  const pieces: string[] = [];
  if (platform === "macos") {
    if (chord.ctrl) pieces.push("⌃");
    if (chord.alt) pieces.push("⌥");
    if (chord.shift) pieces.push("⇧");
    if (chord.meta) pieces.push("⌘");
  } else {
    if (chord.ctrl) pieces.push("Ctrl");
    if (chord.alt) pieces.push("Alt");
    if (chord.shift) pieces.push("Shift");
    if (chord.meta) pieces.push("Meta");
  }
  const label = chord.code === DIGIT_KEY_TEMPLATE
    ? "1-9"
    : chord.code.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Numpad/, "Num ");
  pieces.push(label);
  return platform === "macos" ? pieces.join("") : pieces.join("+");
}
