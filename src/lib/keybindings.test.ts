import { describe, expect, it } from "vitest";
import {
  DIGIT_KEY_TEMPLATE,
  findKeybindingConflicts,
  formatKeyChord,
  isEditableShortcutTarget,
  matchDigitKeyChord,
  matchesKeyChord,
  sanitizeKeyChord,
  shouldIgnoreGlobalShortcut,
  type KeyChord,
  type KeyEventLike,
} from "./keybindings";

const altDigits: KeyChord = { code: DIGIT_KEY_TEMPLATE, ctrl: false, alt: true, shift: false, meta: false };

function keyEvent(overrides: Partial<KeyEventLike> = {}): KeyEventLike {
  return {
    code: "KeyC",
    key: "c",
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...overrides,
  };
}

describe("key chord sanitization", () => {
  it("normalizes missing modifier flags", () => {
    expect(sanitizeKeyChord({ code: "KeyF", ctrl: true })).toEqual({
      code: "KeyF", ctrl: true, alt: false, shift: false, meta: false,
    });
  });

  it("rejects bare printable keys, modifier keys, and malformed codes", () => {
    expect(sanitizeKeyChord({ code: "KeyA" })).toBeNull();
    expect(sanitizeKeyChord({ code: "Digit1", shift: true })).toBeNull();
    expect(sanitizeKeyChord({ code: "ControlLeft", ctrl: true })).toBeNull();
    expect(sanitizeKeyChord({ code: "not-a-code", ctrl: true })).toBeNull();
  });

  it("accepts non-printable and modified printable keys", () => {
    expect(sanitizeKeyChord({ code: "Insert", shift: true })).toMatchObject({ code: "Insert", shift: true });
    expect(sanitizeKeyChord({ code: "KeyV", ctrl: true })).toMatchObject({ code: "KeyV", ctrl: true });
    expect(sanitizeKeyChord({ code: "F12" })).toMatchObject({ code: "F12" });
  });

  it("requires an explicit opt-in and modifier for the digit template", () => {
    expect(sanitizeKeyChord({ code: DIGIT_KEY_TEMPLATE, alt: true })).toBeNull();
    expect(sanitizeKeyChord({ code: DIGIT_KEY_TEMPLATE }, { allowDigitTemplate: true })).toBeNull();
    expect(sanitizeKeyChord({ code: DIGIT_KEY_TEMPLATE, alt: true }, { allowDigitTemplate: true })).toEqual(altDigits);
  });
});

describe("key chord matching", () => {
  const copy: KeyChord = { code: "KeyC", ctrl: true, alt: false, shift: true, meta: false };

  it("matches code and modifiers exactly", () => {
    expect(matchesKeyChord(keyEvent({ code: "KeyC", ctrlKey: true, shiftKey: true }), copy)).toBe(true);
    expect(matchesKeyChord(keyEvent({ code: "KeyC", ctrlKey: true }), copy)).toBe(false);
    expect(matchesKeyChord(keyEvent({ code: "KeyC", ctrlKey: true, shiftKey: true, altKey: true }), copy)).toBe(false);
  });

  it("guards repeats, IME composition, keyCode 229, and AltGraph", () => {
    const base = { code: "KeyC", ctrlKey: true, shiftKey: true } as const;
    expect(matchesKeyChord(keyEvent({ ...base, repeat: true }), copy)).toBe(false);
    expect(matchesKeyChord(keyEvent({ ...base, isComposing: true }), copy)).toBe(false);
    expect(matchesKeyChord(keyEvent({ ...base, keyCode: 229 }), copy)).toBe(false);
    expect(matchesKeyChord(keyEvent({ ...base, getModifierState: key => key === "AltGraph" }), copy)).toBe(false);
  });

  it("maps only top-row Digit1 through Digit9 to quick-switch slots", () => {
    expect(matchDigitKeyChord(keyEvent({ code: "Digit1", altKey: true }), altDigits)).toBe(1);
    expect(matchDigitKeyChord(keyEvent({ code: "Digit9", altKey: true }), altDigits)).toBe(9);
    expect(matchDigitKeyChord(keyEvent({ code: "Digit0", altKey: true }), altDigits)).toBeNull();
    expect(matchDigitKeyChord(keyEvent({ code: "Numpad1", altKey: true }), altDigits)).toBeNull();
    expect(matchDigitKeyChord(keyEvent({ code: "Digit1", altKey: true, ctrlKey: true }), altDigits)).toBeNull();
  });
});

describe("global shortcut safety and conflicts", () => {
  it("suppresses shortcuts originating in editable controls", () => {
    const target = { closest: (selector: string) => selector.includes("input") ? {} : null } as unknown as EventTarget;
    expect(isEditableShortcutTarget(target)).toBe(true);
    expect(shouldIgnoreGlobalShortcut(keyEvent({ target }))).toBe(true);
    expect(isEditableShortcutTarget({ tagName: "DIV" } as unknown as EventTarget)).toBe(false);
  });

  it("allows global shortcuts through xterm's hidden input textarea", () => {
    const target = {
      closest: (selector: string) => selector === ".xterm-helper-textarea" || selector.includes("textarea") ? {} : null,
    } as unknown as EventTarget;
    expect(isEditableShortcutTarget(target)).toBe(false);
    expect(shouldIgnoreGlobalShortcut(keyEvent({ target }))).toBe(false);
  });

  it("suppresses shortcuts while an aria modal is active", () => {
    const previousDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        documentElement: { dataset: {} },
        querySelector: (selector: string) => selector === '[aria-modal="true"]' ? {} : null,
      },
    });
    try {
      expect(shouldIgnoreGlobalShortcut(keyEvent({ code: "Digit1", altKey: true }))).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: previousDocument,
      });
    }
  });

  it("detects exact and digit-template overlaps but not modifier differences", () => {
    const conflicts = findKeybindingConflicts({
      quickSwitch: altDigits,
      directFourth: { code: "Digit4", ctrl: false, alt: true, shift: false, meta: false },
      ctrlFourth: { code: "Digit4", ctrl: true, alt: false, shift: false, meta: false },
      copies: [
        { code: "KeyC", ctrl: true, alt: false, shift: true, meta: false },
        { code: "KeyC", ctrl: true, alt: false, shift: true, meta: false },
      ],
    });
    expect(conflicts).toEqual([
      { firstId: "quickSwitch", firstIndex: 0, secondId: "directFourth", secondIndex: 0 },
      { firstId: "copies", firstIndex: 0, secondId: "copies", secondIndex: 1 },
    ]);
  });

  it("formats platform-specific labels", () => {
    expect(formatKeyChord(altDigits, "windows")).toBe("Alt+1-9");
    expect(formatKeyChord({ code: "KeyF", ctrl: false, alt: false, shift: false, meta: true }, "macos")).toBe("⌘F");
  });
});
