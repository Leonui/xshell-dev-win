import type { IBufferRange, Terminal } from "@xterm/xterm";

export interface TerminalFileReference {
  text: string;
  path: string;
  line: number;
  column: number;
  startIndex: number;
  endIndex: number;
}

export interface TerminalFileLink extends TerminalFileReference {
  range: IBufferRange;
}

export type TerminalLinkSource = Pick<Terminal, "buffer" | "cols">;

const MAX_FILE_REFERENCE_LENGTH = 2048;
const MAX_LOGICAL_LINE_LENGTH = 16_384;
const MAX_LOGICAL_ROWS = 128;
const MAX_POSITION = 2_147_483_647;

// Bare filenames need a recognizable file suffix. Paths containing a separator and absolute
// paths do not: compiler output can legitimately point at `src/Makefile:12` or `/tmp/script:4`.
const BARE_FILE_EXTENSIONS = new Set([
  "astro", "bash", "bat", "c", "cc", "cfg", "clj", "cljs", "cmd", "conf", "cpp", "cs", "css", "csv",
  "dart", "ex", "exs", "fish", "go", "graphql", "h", "hpp", "html", "ini", "java", "js", "json", "jsx",
  "kt", "kts", "less", "lua", "md", "mjs", "mts", "php", "pl", "ps1", "py", "rb", "rs", "sass", "scala",
  "scss", "sh", "sql", "svelte", "swift", "toml", "ts", "tsx", "txt", "vue", "xml", "yaml", "yml", "zig",
]);

const BARE_FILE_NAMES = new Set(["dockerfile", "gemfile", "makefile", "procfile", "rakefile"]);
const QUOTES = new Set(["\"", "'", "`"]);
const UNQUOTED_BOUNDARY = /[\s()[\]{}<>"'`,;=]/;

// Match the numeric location from the right. Keeping path extraction separate avoids treating
// the drive colon in `C:\\work\\main.ts:12:3` as a location separator.
const LOCATION_SUFFIX = /:(\d{1,10})(?::(\d{1,10}))?(?=$|[\s)\]}>,'"`;])/g;

function parsePosition(value: string | undefined, fallback: number): number | null {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_POSITION ? parsed : null;
}

function hasPlausibleBareFileName(path: string): boolean {
  const lower = path.toLowerCase();
  if (BARE_FILE_NAMES.has(lower)) return true;
  const dot = lower.lastIndexOf(".");
  return dot > 0 && BARE_FILE_EXTENSIONS.has(lower.slice(dot + 1));
}

function isPlausibleFilePath(path: string): boolean {
  if (!path || path.length > MAX_FILE_REFERENCE_LENGTH || /[\u0000-\u001f\u007f]/.test(path)) return false;
  if (path.includes("://") || /^file:/i.test(path)) return false;

  const windowsAbsolute = /^[a-zA-Z]:[\\/]/.test(path);
  const uncAbsolute = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(path);
  const posixAbsolute = path.startsWith("/") && !path.startsWith("//");
  if (!windowsAbsolute && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return false;
  if (windowsAbsolute || uncAbsolute || posixAbsolute) return true;

  if (/^(?:\.\.?)[\\/]/.test(path)) return true;
  if (path.includes("/") || path.includes("\\")) {
    // Host:port-like output and naked network addresses are not project paths.
    if (/^\d+(?:\.\d+){3}[\\/]/.test(path)) return false;
    return !path.startsWith("-");
  }
  if (/^\d+(?:\.\d+){3}$/.test(path) || /^\d{1,2}:\d{2}$/.test(path)) return false;
  return hasPlausibleBareFileName(path);
}

interface ExtractedPath {
  path: string;
  linkStart: number;
  linkEnd: number;
}

function findOpeningQuote(text: string, closeIndex: number, quote: string): number {
  for (let i = closeIndex - 1; i >= 0; i--) {
    if (text[i] === quote && (i === 0 || text[i - 1] !== "\\")) return i;
  }
  return -1;
}

function extractPath(text: string, suffixStart: number, suffixEnd: number): ExtractedPath | null {
  const beforeSuffix = text[suffixStart - 1];
  if (QUOTES.has(beforeSuffix)) {
    // `"path with spaces.ts":12:3`
    const opening = findOpeningQuote(text, suffixStart - 1, beforeSuffix);
    if (opening >= 0) {
      return { path: text.slice(opening + 1, suffixStart - 1), linkStart: opening, linkEnd: suffixEnd };
    }
  }

  const afterSuffix = text[suffixEnd];
  if (QUOTES.has(afterSuffix)) {
    // `"path with spaces.ts:12:3"`
    const opening = findOpeningQuote(text, suffixStart, afterSuffix);
    if (opening >= 0) {
      return { path: text.slice(opening + 1, suffixStart), linkStart: opening, linkEnd: suffixEnd + 1 };
    }
  }

  let start = suffixStart;
  while (start > 0 && !UNQUOTED_BOUNDARY.test(text[start - 1])) start--;
  let path = text.slice(start, suffixStart);

  // Compiler prefixes can be adjacent (`-->src/main.rs:2:4`). Keep them out of the link.
  const prefix = /^(?:--?>|=>|@)+/.exec(path)?.[0].length ?? 0;
  start += prefix;
  path = path.slice(prefix);
  return path ? { path, linkStart: start, linkEnd: suffixEnd } : null;
}

export function parseTerminalFileReferences(text: string): TerminalFileReference[] {
  if (!text || text.length > MAX_LOGICAL_LINE_LENGTH) return [];
  const references: TerminalFileReference[] = [];
  LOCATION_SUFFIX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = LOCATION_SUFFIX.exec(text)) !== null) {
    const line = parsePosition(match[1], 1);
    const column = parsePosition(match[2], 1);
    if (line === null || column === null) continue;

    const extracted = extractPath(text, match.index, LOCATION_SUFFIX.lastIndex);
    if (!extracted || !isPlausibleFilePath(extracted.path)) continue;
    references.push({
      text: text.slice(extracted.linkStart, extracted.linkEnd),
      path: extracted.path,
      line,
      column,
      startIndex: extracted.linkStart,
      endIndex: extracted.linkEnd,
    });
  }

  const occupied = references.map(reference => [reference.startIndex, reference.endIndex] as const);
  const urlRanges: Array<readonly [number, number]> = [];
  const urlPattern = /https?:\/\/[^\s<>"']+/gi;
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = urlPattern.exec(text)) !== null) urlRanges.push([urlMatch.index, urlPattern.lastIndex]);
  const overlaps = (start: number, end: number) => [...occupied, ...urlRanges]
    .some(([rangeStart, rangeEnd]) => start < rangeEnd && end > rangeStart);
  const addPathOnly = (path: string, linkStart: number, linkEnd: number) => {
    if (overlaps(linkStart, linkEnd) || !isPlausibleFilePath(path)) return;
    references.push({
      text: text.slice(linkStart, linkEnd),
      path,
      line: 1,
      column: 1,
      startIndex: linkStart,
      endIndex: linkEnd,
    });
    occupied.push([linkStart, linkEnd]);
  };

  // Quoted references are scanned separately so spaces stay part of the path.
  for (let index = 0; index < text.length; index++) {
    const quote = text[index];
    if (!QUOTES.has(quote)) continue;
    let end = index + 1;
    while (end < text.length && (text[end] !== quote || text[end - 1] === "\\")) end++;
    if (end >= text.length) continue;
    addPathOnly(text.slice(index + 1, end), index, end + 1);
    index = end;
  }

  // Remaining unquoted candidates are maximal boundary-delimited tokens. Numeric location
  // references and URLs are already occupied, so this pass only adds path-only forms.
  let index = 0;
  while (index < text.length) {
    while (index < text.length && UNQUOTED_BOUNDARY.test(text[index])) index++;
    const rawStart = index;
    while (index < text.length && !UNQUOTED_BOUNDARY.test(text[index])) index++;
    if (rawStart === index) continue;
    let start = rawStart;
    let candidate = text.slice(rawStart, index);
    const prefixLength = /^(?:--?>|=>|@)+/.exec(candidate)?.[0].length ?? 0;
    start += prefixLength;
    candidate = candidate.slice(prefixLength);
    addPathOnly(candidate, start, index);
  }

  return references.sort((a, b) => a.startIndex - b.startIndex);
}

export interface LogicalTerminalLine {
  text: string;
  startRow: number;
}

/** Joins the complete wrapped logical row containing the provider's 1-based buffer line. */
export function getLogicalTerminalLine(bufferLineNumber: number, terminal: TerminalLinkSource): LogicalTerminalLine | null {
  if (!Number.isInteger(bufferLineNumber) || bufferLineNumber < 1) return null;
  const buffer = terminal.buffer.active;
  let startRow = bufferLineNumber - 1;
  let line = buffer.getLine(startRow);
  if (!line) return null;

  let rows = 1;
  while (line.isWrapped && startRow > 0 && rows < MAX_LOGICAL_ROWS) {
    startRow--;
    rows++;
    line = buffer.getLine(startRow);
    if (!line) return null;
  }

  const chunks: string[] = [];
  let row = startRow;
  while (rows <= MAX_LOGICAL_ROWS) {
    const current = buffer.getLine(row);
    if (!current) break;
    const next = buffer.getLine(row + 1);
    const wrapsToNext = next?.isWrapped === true;
    chunks.push(current.translateToString(!wrapsToNext, 0, terminal.cols));
    if (!wrapsToNext) break;
    if (chunks.reduce((total, chunk) => total + chunk.length, 0) > MAX_LOGICAL_LINE_LENGTH) return null;
    row++;
    rows++;
  }

  const text = chunks.join("");
  return text.length <= MAX_LOGICAL_LINE_LENGTH ? { text, startRow } : null;
}

/** Maps a UTF-16 string offset in a joined wrapped line back to a 0-based xterm cell. */
function mapStringIndex(
  terminal: TerminalLinkSource,
  lineIndex: number,
  columnIndex: number,
  stringIndex: number,
): [row: number, column: number] | null {
  const buffer = terminal.buffer.active;
  const cell = buffer.getNullCell();
  let startColumn = columnIndex;
  while (true) {
    const line = buffer.getLine(lineIndex);
    if (!line) return null;
    const length = Math.min(line.length, terminal.cols);
    for (let column = startColumn; column < length; column++) {
      line.getCell(column, cell);
      const chars = cell.getChars();
      const width = cell.getWidth();
      if (width <= 0) continue;

      // xterm can leave an empty final padding cell when a width-2 glyph wraps. That
      // cell is not present in translateToString(), so it contributes no string units.
      let units = chars.length || 1;
      if (column === length - 1 && chars === "") {
        const next = buffer.getLine(lineIndex + 1);
        if (next?.isWrapped) {
          next.getCell(0, cell);
          if (cell.getWidth() === 2) units = 0;
        }
      }
      if (units === 0) continue;
      if (stringIndex <= 0 || stringIndex < units) return [lineIndex, column];

      stringIndex -= units;
      if (stringIndex === 0) {
        const nextColumn = column + width;
        if (nextColumn < length) return [lineIndex, nextColumn];
        const next = buffer.getLine(lineIndex + 1);
        return next?.isWrapped ? [lineIndex + 1, 0] : [lineIndex, nextColumn];
      }
    }
    lineIndex++;
    startColumn = 0;
  }
}

export function computeTerminalFileLinks(bufferLineNumber: number, terminal: TerminalLinkSource): TerminalFileLink[] {
  const logical = getLogicalTerminalLine(bufferLineNumber, terminal);
  if (!logical) return [];

  const links: TerminalFileLink[] = [];
  for (const reference of parseTerminalFileReferences(logical.text)) {
    const start = mapStringIndex(terminal, logical.startRow, 0, reference.startIndex);
    const end = mapStringIndex(terminal, logical.startRow, 0, reference.endIndex);
    if (!start || !end) continue;

    let [endRow, endColumn] = end;
    // An exclusive index exactly at a wrap boundary maps to column zero of the next row;
    // IBufferRange's inclusive end belongs to the final cell of the preceding row.
    if (endColumn === 0 && endRow > start[0]) {
      endRow--;
      endColumn = terminal.cols;
    }
    if (endColumn < 1) continue;

    links.push({
      ...reference,
      range: {
        start: { x: start[1] + 1, y: start[0] + 1 },
        end: { x: endColumn, y: endRow + 1 },
      },
    });
  }
  return links;
}
