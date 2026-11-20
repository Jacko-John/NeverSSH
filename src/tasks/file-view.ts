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
  flags: /^(-[inwFxvEHabohsIl]+|-[ABCm]\d+|--(?:line-number|fixed-strings|ignore-case|word-regexp))$/,
  values: searchCounts,
};
const programs: ReadonlyMap<string, ViewOptions> = new Map([
  ["head", headTail], ["tail", headTail], ["bat", bat], ["batcat", bat],
  ["grep", grep], ["egrep", grep], ["fgrep", grep],
  ["rg", {
    search: true,
    flags: /^(-[inwFxvHabosIluUS]+|-[ABCm]\d+|--(?:no-heading|line-number|fixed-strings|ignore-case|word-regexp|hidden|no-ignore))$/,
    values: searchCounts,
  }],
  ["cat", { flags: /^(-[AbEnsTtuv]+|--(?:number|number-nonblank|squeeze-blank|show-all|show-ends|show-tabs|show-nonprinting))$/ }],
  ["nl", { flags: /^(-b[atn]|-n(?:ln|rn|rz)|-w\d+)$/, values: { "-b": /^[atn]$/, "-n": /^(ln|rn|rz)$/, "-w": count } }],
  ["sed", { flags: /^-n$/ }],
]);

/** Options that can read another file, change the action, or invoke another program do not qualify. */
export function viewedFile(command: string, home: string): { path: string; search: boolean } | undefined {
  const words = simpleCommandWords(command, home);
  if (!words) return;
  const [program, ...args] = words;
  const name = program!.replace(/^\/(?:usr\/)?bin\//, "");
  const spec = programs.get(name);
  if (!spec) return;

  const operands: string[] = [];
  let options = true;
  let explicitPattern = false;
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
    }
  }

  if (name === "sed") {
    if (args[0] !== "-n" || !/^\d+(?:,(?:\d+|\$))?p$/.test(operands.shift() ?? "")) return;
  } else if (spec.search && !explicitPattern) {
    operands.shift();
  }
  const [path] = operands;
  if (operands.length === 1 && path && path !== "-") return { path, search: !!spec.search };
}
