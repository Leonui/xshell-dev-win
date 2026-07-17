import { describe, expect, it } from "vitest";
import {
  computeTerminalFileLinks,
  getLogicalTerminalLine,
  parseTerminalFileReferences,
  type TerminalLinkSource,
} from "./terminalFileLinks";

class FakeCell {
  constructor(private chars = "", private width = 1) {}
  load(other: FakeCell): void { this.chars = other.chars; this.width = other.width; }
  getChars(): string { return this.chars; }
  getWidth(): number { return this.width; }
  getCode(): number { return this.chars.codePointAt(0) ?? 0; }
}

function cellWidth(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  return char === "界" || codePoint > 0xffff ? 2 : 1;
}

class FakeLine {
  readonly cells: FakeCell[] = [];
  readonly length: number;

  constructor(text: string, readonly isWrapped: boolean, cols: number) {
    for (const char of text) {
      const width = cellWidth(char);
      this.cells.push(new FakeCell(char, width));
      if (width === 2) this.cells.push(new FakeCell("", 0));
    }
    while (this.cells.length < cols) this.cells.push(new FakeCell());
    this.length = this.cells.length;
  }

  getCell(index: number, target?: FakeCell): FakeCell | undefined {
    const cell = this.cells[index];
    if (!cell) return undefined;
    if (target) { target.load(cell); return target; }
    return cell;
  }

  translateToString(trimRight = false, startColumn = 0, endColumn = this.cells.length): string {
    let value = "";
    for (let column = startColumn; column < Math.min(endColumn, this.cells.length); column++) {
      const cell = this.cells[column];
      if (cell.getWidth() === 0) continue;
      value += cell.getChars() || " ";
    }
    return trimRight ? value.trimEnd() : value;
  }
}

function fakeTerminal(rows: string[], cols: number, wrappedRows: number[] = []): TerminalLinkSource {
  const wrapped = new Set(wrappedRows);
  const lines = rows.map((row, index) => new FakeLine(row, wrapped.has(index), cols));
  return {
    cols,
    buffer: {
      active: {
        getLine: (index: number) => lines[index],
        getNullCell: () => new FakeCell(),
      },
    },
  } as unknown as TerminalLinkSource;
}

function wrappedTerminal(text: string, cols: number): { terminal: TerminalLinkSource; rows: string[] } {
  const rows: string[] = [];
  let row = "";
  let width = 0;
  for (const char of text) {
    const nextWidth = cellWidth(char);
    if (width > 0 && width + nextWidth > cols) {
      rows.push(row);
      row = "";
      width = 0;
    }
    row += char;
    width += nextWidth;
    if (width === cols) {
      rows.push(row);
      row = "";
      width = 0;
    }
  }
  if (row || rows.length === 0) rows.push(row);
  return { terminal: fakeTerminal(rows, cols, rows.slice(1).map((_, index) => index + 1)), rows };
}

describe("terminal file-reference parsing", () => {
  it("parses absolute, relative, line-only, and bare source filenames", () => {
    const text = "at /home/me/app/main.rs:12:3 ./test.ts:8 ../Makefile:4 src/view.tsx:9:2 Dockerfile:6";
    expect(parseTerminalFileReferences(text).map(({ path, line, column }) => ({ path, line, column }))).toEqual([
      { path: "/home/me/app/main.rs", line: 12, column: 3 },
      { path: "./test.ts", line: 8, column: 1 },
      { path: "../Makefile", line: 4, column: 1 },
      { path: "src/view.tsx", line: 9, column: 2 },
      { path: "Dockerfile", line: 6, column: 1 },
    ]);
  });

  it("parses Windows drive and UNC paths without confusing their colons", () => {
    const text = String.raw`C:\work\src\main.ts:42:7 \\server\share\app\Program.cs:9:2 C:/work/test.py:5`;
    expect(parseTerminalFileReferences(text).map(ref => [ref.path, ref.line, ref.column])).toEqual([
      [String.raw`C:\work\src\main.ts`, 42, 7],
      [String.raw`\\server\share\app\Program.cs`, 9, 2],
      ["C:/work/test.py", 5, 1],
    ]);
  });

  it("accepts quoted paths with spaces whether the location is inside or outside the quote", () => {
    const text = String.raw`"C:\Users\Ang Li\main.ts":12:3 '/home/ang li/test.py:7:2'`;
    const refs = parseTerminalFileReferences(text);
    expect(refs.map(ref => [ref.path, ref.line, ref.column])).toEqual([
      [String.raw`C:\Users\Ang Li\main.ts`, 12, 3],
      ["/home/ang li/test.py", 7, 2],
    ]);
    expect(refs.map(ref => ref.text)).toEqual([
      String.raw`"C:\Users\Ang Li\main.ts":12:3`,
      "'/home/ang li/test.py:7:2'",
    ]);
  });

  it("strips adjacent diagnostic punctuation from the path and link", () => {
    const [ref] = parseTerminalFileReferences("-->src/main.rs:2:4)");
    expect(ref).toMatchObject({ path: "src/main.rs", text: "src/main.rs:2:4", startIndex: 3 });
  });

  it("parses path-only absolute, project-relative, bare, and quoted references", () => {
    const text = String.raw`open C:\work\src\main.ts and src/view.tsx plus Dockerfile or "/home/ang li/test.py"`;
    expect(parseTerminalFileReferences(text).map(ref => [ref.path, ref.line, ref.column])).toEqual([
      [String.raw`C:\work\src\main.ts`, 1, 1],
      ["src/view.tsx", 1, 1],
      ["Dockerfile", 1, 1],
      ["/home/ang li/test.py", 1, 1],
    ]);
  });

  it("does not create path-only links inside HTTP URLs or duplicate located references", () => {
    const refs = parseTerminalFileReferences("https://example.test/src/main.ts src/main.ts:4:2");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ path: "src/main.ts", line: 4, column: 2 });
  });

  it("rejects URLs, protocols, timestamps, IP addresses, labels, and invalid positions", () => {
    const text = "https://example.test/src/a.ts:12:3 node:internal/modules/a.js:4:2 12:34:56 127.0.0.1:80:2 label:12:3 main.ts:0:1 main.ts:2147483648:1";
    expect(parseTerminalFileReferences(text)).toEqual([]);
  });
});

describe("xterm wrapped-line range mapping", () => {
  it("returns 1-based ranges on a single row", () => {
    const terminal = fakeTerminal(["at src/a.ts:12:3"], 40);
    const [link] = computeTerminalFileLinks(1, terminal);
    expect(link.path).toBe("src/a.ts");
    expect(link.range).toEqual({ start: { x: 4, y: 1 }, end: { x: 16, y: 1 } });
  });

  it("joins and maps a reference spanning multiple wrapped rows", () => {
    const { terminal, rows } = wrappedTerminal("error src/main.ts:12:3", 10);
    expect(rows.length).toBe(3);
    expect(getLogicalTerminalLine(2, terminal)?.text).toBe("error src/main.ts:12:3");
    const [link] = computeTerminalFileLinks(2, terminal);
    expect(link.range).toEqual({ start: { x: 7, y: 1 }, end: { x: 2, y: 3 } });
  });

  it("keeps an exact wrap-boundary end on the preceding row", () => {
    const { terminal } = wrappedTerminal("  main.ts:1", 11);
    const [link] = computeTerminalFileLinks(1, terminal);
    expect(link.range).toEqual({ start: { x: 3, y: 1 }, end: { x: 11, y: 1 } });
  });

  it("accounts for wide cells before a reference", () => {
    const terminal = fakeTerminal(["界 src/a.ts:1:2"], 30);
    const [link] = computeTerminalFileLinks(1, terminal);
    expect(link.range.start).toEqual({ x: 4, y: 1 });
    expect(link.range.end).toEqual({ x: 15, y: 1 });
  });

  it("returns no links for invalid provider rows", () => {
    const terminal = fakeTerminal(["src/a.ts:1:2"], 20);
    expect(computeTerminalFileLinks(0, terminal)).toEqual([]);
    expect(computeTerminalFileLinks(2, terminal)).toEqual([]);
  });
});
