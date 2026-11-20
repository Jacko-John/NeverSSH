/** Inspect a single command without evaluation. A null word would require shell expansion. */
function inspectWords(command: string, home?: string): (string | null)[] | undefined {
  if (/[\r\0]/.test(command)) return undefined;
  if (command.includes("\n")) {
    const lines = command.split("\n").filter((line) => /[^ \t]/.test(line));
    if (lines.length !== 1) return undefined;
    command = lines[0]!;
  }
  const words: (string | null)[] = [];
  let word: string | undefined;
  let expanded = false;
  let quote: "'" | '"' | undefined;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (!quote && (ch === " " || ch === "\t")) {
      if (word !== undefined) words.push(expanded ? null : word);
      word = undefined;
      expanded = false;
      continue;
    }
    if (ch === quote) {
      quote = undefined;
      continue;
    }
    const startsWord = word === undefined;
    word ??= "";
    if (!quote && (ch === "'" || ch === '"')) {
      quote = ch;
      continue;
    }
    if (quote !== "'" && ch === "\\") {
      const next = command[++i];
      if (next === undefined) return undefined;
      // Inside double quotes, Bash preserves backslashes before ordinary characters.
      if (quote === '"' && !['"', "\\", "$", "`"].includes(next)) word += "\\";
      word += next;
      continue;
    }
    if (quote !== "'" && ch === "`") return undefined;
    if (quote !== "'" && ch === "$") {
      const next = command[i + 1] ?? "";
      if (next === "(" || next === "[" || (!quote && (next === '"' || next === "'"))) return undefined;
      if (next === "{") {
        const end = command.indexOf("}", i + 2);
        if (end < 0 || !/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(command.slice(i + 2, end))) return undefined;
        expanded = true;
        i = end;
        continue;
      }
      if (/[a-zA-Z_0-9@*#?!$-]/.test(next)) expanded = true;
    }
    if (!quote && ("|&;()<>{}".includes(ch) || (startsWord && ch === "#"))) return undefined;
    // Use the remote worker's HOME only for an unquoted, word-initial ~/.
    if (!quote && startsWord && ch === "~" && command[i + 1] === "/" && home) {
      word = home;
      continue;
    }
    if (!quote && "~*?".includes(ch)) expanded = true;
    // A lone '[' is a command name. Inside longer words it can introduce a glob.
    if (!quote && ch === "[" && (word || !["", " ", "\t"].includes(command[i + 1] ?? ""))) expanded = true;
    word += ch;
  }
  if (quote) return undefined;
  if (word !== undefined) words.push(expanded ? null : word);
  return words.length ? words : undefined;
}

/** A file view needs a single, fully literal operand list to identify what Bash opened. */
export function simpleCommandWords(command: string, home: string): string[] | undefined {
  const words = inspectWords(command, home);
  return words?.every((word): word is string => word !== null) ? words : undefined;
}

const EXIT_ONE_COMMANDS = new Set(["grep", "rg", "egrep", "fgrep", "find", "diff", "test", "["]);

/** Wildcards or variables in operands still permit a literal executable to determine the status. */
export function acceptsExitOne(command: string): boolean {
  const words = inspectWords(command);
  if (!words) return false;
  const name = words[0]?.replace(/^\/(?:usr\/)?bin\//, "");
  if (name !== "git") return !!name && EXIT_ONE_COMMANDS.has(name);
  // Skip common global options, taking care not to mistake their values for a subcommand.
  for (let i = 1; i < words.length; i++) {
    const arg = words[i];
    if (arg === "-c" || arg === "-C") {
      if (typeof words[++i] !== "string") return false;
      continue;
    }
    if (arg === "--no-pager" || arg === "--no-optional-locks") continue;
    return arg === "diff" || arg === "grep";
  }
  return false;
}
