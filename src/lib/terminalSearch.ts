export interface TerminalSearchRequest {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  direction: "next" | "previous";
  incremental: boolean;
}

export type TerminalSearchPlan =
  | { kind: "clear" }
  | { kind: "invalid"; message: string }
  | {
      kind: "find";
      query: string;
      direction: "next" | "previous";
      options: {
        regex: boolean;
        caseSensitive: boolean;
        incremental: boolean;
      };
    };

export function planTerminalSearch(request: TerminalSearchRequest): TerminalSearchPlan {
  if (!request.query) return { kind: "clear" };
  if (request.regex) {
    try {
      new RegExp(request.query, request.caseSensitive ? "" : "i");
    } catch (error) {
      return {
        kind: "invalid",
        message: error instanceof Error ? error.message : "Invalid regular expression",
      };
    }
  }
  return {
    kind: "find",
    query: request.query,
    direction: request.direction,
    options: {
      regex: request.regex,
      caseSensitive: request.caseSensitive,
      incremental: request.incremental,
    },
  };
}

export function formatTerminalSearchResults(
  query: string,
  error: string | null,
  index: number,
  count: number,
): string {
  if (error) return "Invalid regex";
  if (!query) return "";
  if (count === 0) return "No results";
  return index < 0 ? `${count}+` : `${index + 1}/${count}`;
}
