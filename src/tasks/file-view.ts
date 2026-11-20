/** Identify the single file operand of common, literal Bash viewing commands. */
import { simpleCommandWords } from "./simple-command";

type ViewOptions = {
  flags: RegExp;
  values?: Record<string, RegExp>;
  search?: boolean;
};

const number = /^[+-]?\d+$/;
const count = /^\d+$/;
const headTail: ViewOptions = {
  flags: /^(-[qv]+|--quiet|--silent|--verbose|-(?:[nc])?[+-]?\d+|--(?:lines|bytes)=[+-]?\d+)$/,
  values: { "-n": number, "-c": number, "--lines": number, "--bytes": number },
};
const bat: ViewOptions = {
  flags: /^(-[npP]+|--plain|--number|--(?:style|color|paging|language|theme|line-range)=.+)$/,
  values: Object.fromEntries(["--style", "--color", "--paging", "--language", "--theme", "--line-range"].map((flag) => [flag, /.+/])),
};
const searchCounts = { "-A": count, "-B": count, "-C": count, "-m": count };
const grep: ViewOptions = {
  search: true,
  flags: /^(-[inwFxvEHabohsI]+|-[ABCm]\d+|--(?:line-number|fixed-strings|ignore-case|word-regexp|text))$/,
  values: searchCounts,
};
const programs: ReadonlyMap<string, ViewOptions> = new Map([
  ["head", headTail], ["tail", headTail], ["bat", bat], ["batcat", bat],
  ["grep", grep], ["egrep", grep], ["fgrep", grep],
  ["rg", {
    search: true,
    flags: /^(-[inwFxvHabosIuUS]+|-[ABCm]\d+|--(?:no-heading|line-number|fixed-strings|ignore-case|word-regexp|hidden|no-ignore|text))$/,
    values: searchCounts,
  }],
  ["cat", { flags: /^(-[AbEnsTtuv]+|--(?:number|number-nonblank|squeeze-blank|show-all|show-ends|show-tabs|show-nonprinting))$/ }],
  ["nl", { flags: /^(-b[atn]|-n(?:ln|rn|rz)|-w\d+)$/, values: { "-b": /^[atn]$/, "-n": /^(ln|rn|rz)$/, "-w": count } }],
  ["sed", { flags: /^-n$/ }],
]);

type MatchPrefix = { filename: string; numericFields: number };
export type FileView = { path: string; search: boolean; binaryAsText: boolean; matchPrefix?: MatchPrefix };

/** Options that can read another file, change the action, or invoke another program do not qualify. */
export function viewedFile(command: string, home: string): FileView | undefined {
  const words = simpleCommandWords(command, home);
  if (!words) return;
  const [program, ...args] = words;
  const name = program!.replace(/^\/(?:usr\/)?bin\//, "");
  const spec = programs.get(name);
  if (!spec) return;

  const operands: string[] = [];
  let options = true;
  let explicitPattern = false;
  let binaryAsText = false;
  let onlyMatching = false;
  let withFilename = false;
  let lineNumber = false;
  let byteOffset = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!options || !arg.startsWith("-") || arg === "-") {
      operands.push(arg);
    } else if (arg === "--") {
      options = false;
    } else if (spec.search && (arg === "-e" || arg === "--regexp")) {
      if (++i >= args.length) return;
      explicitPattern = true;
    } else if (spec.search && (/^-e.+/.test(arg) || arg.startsWith("--regexp="))) {
      explicitPattern = true;
    } else if (spec.values?.[arg]) {
      if (!spec.values[arg].test(args[++i] ?? "")) return;
    } else if (!spec.flags.test(arg)) {
      return;
    } else if (spec.search) {
      const flags = arg.startsWith("--") ? "" : arg.slice(1);
      binaryAsText ||= arg === "--text" || flags.includes("a");
      onlyMatching ||= flags.includes("o");
      lineNumber ||= arg === "--line-number" || flags.includes("n");
      byteOffset ||= flags.includes("b");
      const show = flags.lastIndexOf("H");
      const hide = flags.lastIndexOf(name === "rg" ? "I" : "h");
      if (show >= 0 || hide >= 0) withFilename = show > hide;
    }
  }

  if (name === "sed") {
    if (args[0] !== "-n" || !/^\d+(?:,(?:\d+|\$))?p$/.test(operands.shift() ?? "")) return;
  } else if (spec.search && !explicitPattern) {
    operands.shift();
  }
  const [path] = operands;
  if (operands.length === 1 && path && path !== "-") {
    const view = { path, search: !!spec.search, binaryAsText };
    if (!onlyMatching) return view;
    return { ...view, matchPrefix: { filename: withFilename ? path + ":" : "", numericFields: Number(lineNumber) + Number(byteOffset) } };
  }
}

/** Match exactly the fields before an empty -o result. A clipped first row can start inside a field. */
function emptyMatchRow(line: string, prefix: MatchPrefix, clipped: boolean): boolean {
  let end = line.length;
  for (let i = 0; i < prefix.numericFields; i++) {
    if (end === 0) return clipped;
    if (line[end - 1] !== ":") return false;
    const start = end === 1 ? 0 : line.lastIndexOf(":", end - 2) + 1;
    if (!/^\d+$/.test(line.slice(start, end - 1))) return clipped && end === 1;
    end = start;
  }
  const filename = line.slice(0, end);
  return clipped ? prefix.filename.endsWith(filename) : prefix.filename === filename;
}

/** Inspect only the stdout that reached the caller. Blank full lines and whitespace matches are valid text. */
export function showsSearchText(view: FileView, stdout: string, hasNul: boolean, clipped = false): boolean {
  if (!stdout) return false;
  const binary = hasNul && !view.binaryAsText;
  if (!binary && !view.matchPrefix) return true;
  // grep and rg can emit a binary-match notice after printing earlier matching lines.
  const lines = stdout.replace(/\n$/, "").split("\n");
  return lines.some((line, index) => {
    if (binary && /^(?:Binary file .* matches|(?:.*: )?binary file matches(?: \(found "\\0" byte around offset \d+\))?)$/.test(line)) return false;
    const prefix = view.matchPrefix;
    if (!prefix) return true;
    if (line === "--" && (prefix.filename || prefix.numericFields)) return false;
    return !emptyMatchRow(line, prefix, clipped && index === 0);
  });
}
