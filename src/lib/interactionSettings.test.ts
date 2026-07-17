import { describe, expect, it } from "vitest";
import { DIGIT_KEY_TEMPLATE } from "./keybindings";
import {
  INTERACTION_SETTINGS_VERSION,
  detectKeybindingPlatform,
  findInteractionSettingConflicts,
  getDefaultInteractionSettings,
  sanitizeInteractionSettings,
  shouldRefocusTerminalAfterMouseAction,
  terminalMouseEventDisposition,
} from "./interactionSettings";

describe("interaction settings defaults", () => {
  it("uses existing Windows terminal conventions", () => {
    const settings = getDefaultInteractionSettings("windows");
    expect(settings.quickActions).toMatchObject({ code: "KeyK", ctrl: true });
    expect(settings.quickSwitch).toMatchObject({ code: DIGIT_KEY_TEMPLATE, alt: true });
    expect(settings.terminalSearch).toMatchObject({ code: "KeyF", ctrl: true });
    expect(settings.reopenClosed).toMatchObject({ code: "KeyT", ctrl: true, shift: true });
    expect(settings.terminalCopy).toEqual([{ code: "KeyC", ctrl: true, alt: false, shift: true, meta: false }]);
    expect(settings.terminalPaste.map(binding => binding.code)).toEqual(["KeyV", "KeyV", "Insert"]);
    expect(settings.middleClick).toBe("selection-or-clipboard-paste");
    expect(settings.rightClick).toBe("context-menu");
  });

  it("uses native Command shortcuts on macOS", () => {
    const settings = getDefaultInteractionSettings("macos");
    expect(settings.terminalSearch).toMatchObject({ code: "KeyF", meta: true, ctrl: false });
    expect(settings.terminalCopy).toEqual([{ code: "KeyC", ctrl: false, alt: false, shift: false, meta: true }]);
    expect(settings.terminalPaste[0]).toMatchObject({ code: "KeyV", meta: true });
  });

  it("detects platform without depending on navigator", () => {
    expect(detectKeybindingPlatform("Mozilla Windows NT 10.0")).toBe("windows");
    expect(detectKeybindingPlatform("Mozilla Macintosh")).toBe("macos");
    expect(detectKeybindingPlatform("Mozilla X11 Linux")).toBe("linux");
  });
});

describe("terminal mouse dispatch", () => {
  it("performs middle-click once and only consumes the later auxclick", () => {
    expect(terminalMouseEventDisposition(1, "mousedown", "paste-clipboard")).toBe("perform");
    expect(terminalMouseEventDisposition(1, "auxclick", "paste-clipboard")).toBe("consume");
  });

  it("consumes right mousedown and performs only the contextmenu phase", () => {
    expect(terminalMouseEventDisposition(2, "mousedown", "selection-or-clipboard-paste")).toBe("consume");
    expect(terminalMouseEventDisposition(2, "contextmenu", "selection-or-clipboard-paste")).toBe("perform");
  });

  it("passes disabled and unrelated mouse events through", () => {
    expect(terminalMouseEventDisposition(2, "mousedown", "none")).toBe("pass");
    expect(terminalMouseEventDisposition(0, "mousedown", "copy-selection")).toBe("pass");
  });

  it("does not steal focus back from a configured context menu", () => {
    expect(shouldRefocusTerminalAfterMouseAction("context-menu")).toBe(false);
    expect(shouldRefocusTerminalAfterMouseAction("paste-clipboard")).toBe(true);
  });
});

describe("interaction settings sanitization", () => {
  it("sanitizes fields independently and migrates the version", () => {
    const settings = sanitizeInteractionSettings({
      version: 999,
      quickActions: { code: "KeyP", ctrl: true },
      quickSwitch: { code: "Digit1", alt: true },
      terminalSearch: { code: "KeyG", ctrl: true },
      reopenClosed: { code: "KeyR", ctrl: true, shift: true },
      terminalCopy: "broken",
      terminalPaste: [
        { code: "KeyP", ctrl: true },
        { code: "KeyP", ctrl: true },
        { code: "KeyQ" },
      ],
      copyOnSelect: true,
      copyCtrlCWhenSelected: "yes",
      middleClick: "copy-selection",
      rightClick: "unsafe-command",
      fileLinksEnabled: false,
      editorPreset: "cursor",
    }, "windows");

    expect(settings.version).toBe(INTERACTION_SETTINGS_VERSION);
    expect(settings.quickActions).toMatchObject({ code: "KeyP", ctrl: true });
    expect(settings.quickSwitch).toEqual(getDefaultInteractionSettings("windows").quickSwitch);
    expect(settings.terminalSearch).toMatchObject({ code: "KeyG", ctrl: true });
    expect(settings.reopenClosed).toMatchObject({ code: "KeyR", ctrl: true, shift: true });
    expect(settings.terminalCopy).toEqual(getDefaultInteractionSettings("windows").terminalCopy);
    expect(settings.terminalPaste).toEqual([{ code: "KeyP", ctrl: true, alt: false, shift: false, meta: false }]);
    expect(settings.copyOnSelect).toBe(true);
    expect(settings.copyCtrlCWhenSelected).toBe(true);
    expect(settings.middleClick).toBe("copy-selection");
    expect(settings.rightClick).toBe("context-menu");
    expect(settings.fileLinksEnabled).toBe(false);
    expect(settings.editorPreset).toBe("cursor");
  });

  it("falls back field-by-field for nulls, invalid arrays, actions, and editors", () => {
    const defaults = getDefaultInteractionSettings("linux");
    const settings = sanitizeInteractionSettings({
      quickActions: null,
      terminalSearch: null,
      reopenClosed: null,
      terminalCopy: [{ code: "KeyC" }],
      terminalPaste: [],
      middleClick: null,
      editorPreset: "shell-command",
    }, "linux");
    expect(settings.quickActions).toEqual(defaults.quickActions);
    expect(settings.terminalSearch).toEqual(defaults.terminalSearch);
    expect(settings.reopenClosed).toEqual(defaults.reopenClosed);
    expect(settings.terminalCopy).toEqual(defaults.terminalCopy);
    expect(settings.terminalPaste).toEqual(defaults.terminalPaste);
    expect(settings.middleClick).toEqual(defaults.middleClick);
    expect(settings.editorPreset).toEqual(defaults.editorPreset);
  });

  it("reports conflicts across independently valid settings", () => {
    const settings = getDefaultInteractionSettings("windows");
    settings.terminalSearch = { ...settings.terminalCopy[0] };
    expect(findInteractionSettingConflicts(settings)).toContainEqual({
      firstId: "terminalSearch", firstIndex: 0, secondId: "terminalCopy", secondIndex: 0,
    });
  });
});
