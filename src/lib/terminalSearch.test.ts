import { describe, expect, it } from "vitest";
import { formatTerminalSearchResults, planTerminalSearch } from "./terminalSearch";

describe("planTerminalSearch", () => {
  it("clears decorations for an empty query", () => {
    expect(planTerminalSearch({ query: "", regex: false, caseSensitive: false, direction: "next", incremental: true })).toEqual({ kind: "clear" });
  });

  it("preserves literal direction and incremental options", () => {
    expect(planTerminalSearch({ query: "a[b", regex: false, caseSensitive: true, direction: "previous", incremental: false })).toEqual({
      kind: "find",
      query: "a[b",
      direction: "previous",
      options: { regex: false, caseSensitive: true, incremental: false },
    });
  });

  it("rejects invalid regex without dispatching it to xterm", () => {
    const plan = planTerminalSearch({ query: "[", regex: true, caseSensitive: false, direction: "next", incremental: true });
    expect(plan.kind).toBe("invalid");
    if (plan.kind === "invalid") expect(plan.message).not.toBe("");
  });

  it("accepts regex and tracks case sensitivity", () => {
    expect(planTerminalSearch({ query: "foo.+bar", regex: true, caseSensitive: false, direction: "next", incremental: true })).toEqual({
      kind: "find",
      query: "foo.+bar",
      direction: "next",
      options: { regex: true, caseSensitive: false, incremental: true },
    });
  });
});

describe("formatTerminalSearchResults", () => {
  it("reports empty, invalid, missing, capped, and indexed states honestly", () => {
    expect(formatTerminalSearchResults("", null, -1, 0)).toBe("");
    expect(formatTerminalSearchResults("foo", "bad", -1, 0)).toBe("Invalid regex");
    expect(formatTerminalSearchResults("foo", null, -1, 0)).toBe("No results");
    expect(formatTerminalSearchResults("foo", null, -1, 2000)).toBe("2000+");
    expect(formatTerminalSearchResults("foo", null, 2, 7)).toBe("3/7");
  });
});
