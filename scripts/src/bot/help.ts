// `--help` / `-h` and unknown-argument refusal for the scripts CLIs (bot, mailroom, board). Each main() calls
// cliGuard first, before any token, git, network or stdin read: `deploy-dev --help` once ran a real dev deploy.
// The caller passes its own arg parser, so a command is found exactly as its main() would find it.

// A command's allowed `--flags` and how many positionals may follow it (and its sub). null: it parses its own.
export type Spec = { flags: readonly string[]; args?: number } | null;
export type Parse = (argv: string[]) => { positional: string[]; flags: Record<string, string> };
export interface Verdict {
  code: number; // 0 help, 2 refused
  out: string;
}

export const isHelp = (a: string) => a === '-h' || a === '--help' || a.startsWith('--help=');

// The commands a USAGE names: the first word of each line indented exactly two spaces.
export const commands = (usage: string) => [
  ...new Set(usage.split('\n').flatMap((l) => /^ {2}(\S+)/.exec(l)?.[1] ?? [])),
];

// `cmd`'s USAGE lines (every line whose first word is cmd) with their deeper-indented continuations.
export function usageFor(usage: string, cmd: string): string | null {
  const [head = '', ...lines] = usage.split('\n');
  let mine = false;
  const out = lines.filter((l) => {
    const m = /^ {2}(\S+)/.exec(l);
    if (m) mine = m[1] === cmd;
    return mine;
  });
  return out.length ? [`${head.split('<command>')[0]}${cmd}`, ...out].join('\n') : null;
}

// Help → that command's usage, exit 0. Unknown flag, stray positional or unknown subcommand → exit 2. Else null:
// main runs (an unknown command falls through to main's own refusal, which runs nothing).
export function cliGuard(
  argv: string[],
  usage: string,
  table: Record<string, Spec>,
  parse: Parse,
): Verdict | null {
  const { positional, flags } = parse(argv.filter((a) => !isHelp(a)));
  const [cmd, sub] = positional;
  if (argv.some(isHelp) || cmd === 'help') {
    const topic = cmd === 'help' ? sub : cmd;
    if (topic === undefined) return { code: 0, out: usage };
    const u = usageFor(usage, topic);
    return u ? { code: 0, out: u } : { code: 2, out: `unknown command "${topic}"\n${usage}` };
  }
  if (cmd === undefined) return null;
  const refuse = (why: string): Verdict => ({
    code: 2,
    out: `${why}\n${usageFor(usage, cmd) ?? usage}`,
  });
  const hasSubs = Object.keys(table).some((k) => k.startsWith(`${cmd} `));
  const key = hasSubs ? `${cmd} ${sub ?? ''}` : cmd;
  if (!(key in table)) return hasSubs ? refuse(`unknown ${cmd} subcommand "${sub ?? ''}"`) : null;
  const spec = table[key];
  if (!spec) return null;
  const bad = Object.keys(flags).filter((f) => !spec.flags.includes(f));
  if (bad.length) return refuse(`${key}: unknown flag ${bad.map((f) => `--${f}`).join(' ')}`);
  const extra = positional.slice(hasSubs ? 2 : 1);
  const dashed = extra.filter((a) => a.startsWith('-'));
  if (dashed.length) return refuse(`${key}: unknown option ${dashed.join(' ')}`);
  if (extra.length > (spec.args ?? 0))
    return refuse(`${key}: unexpected argument ${extra.join(' ')}`);
  return null;
}

// Print a verdict where main would (usage on stdout, a refusal on stderr) and hand back its exit code.
export function emit(v: Verdict): number {
  (v.code ? console.error : console.log)(v.out);
  return v.code;
}
