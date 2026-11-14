// A caller job's `permissions` must cover everything the reusable workflow it calls declares — top-level and
// per job. GitHub checks this only when the run starts: a gap is a `startup_failure` that nothing earlier
// catches (PR checks never run deploy workflows; actionlint reads one file at a time). PR 69 shipped one —
// `deploy-stage.yml` declared `deployments: read`, only its prod caller granted it — and blocked every deploy.
//
// A narrow reader for our own workflows, not a YAML parser: a 2-space layout, `permissions` as a block of
// `scope: read|write|none` lines. A shape it can't read throws rather than guess — a silent pass is the bug
// this exists to stop. It checks the called workflow's top level as well as each job, which may be stricter
// than GitHub (a loud false positive, never a quiet miss).

export type Perms = Record<string, string>;
export interface Job {
  perms?: Perms;
  uses?: string;
}
export interface Workflow {
  perms?: Perms;
  jobs: Record<string, Job>;
}

const LEVEL: Record<string, number> = { none: 0, read: 1, write: 2 };
const KEY = /^( *)([A-Za-z0-9_-]+):\s*(.*?)\s*$/;
const stripComment = (v: string) => v.replace(/(^|\s)#.*$/, '').trim();
const unquote = (v: string) => v.replace(/^(['"])(.*)\1$/, '$2');
const indentOf = (line: string) => line.length - line.trimStart().length;
export const isContent = (line: string) => !!line.trim() && !line.trim().startsWith('#');

export function parseWorkflow(text: string, name = 'workflow'): Workflow {
  const lines = text.split('\n');
  const wf: Workflow = { jobs: {} };
  let inJobs = false;
  let job: Job | undefined;

  const readPerms = (i: number, indent: number, value: string): Perms => {
    if (value)
      throw new Error(
        `${name}:${i + 1}: unsupported permissions form "${value}" — use a block of scope: level lines`,
      );
    const perms: Perms = {};
    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j] ?? '';
      if (!isContent(raw)) continue;
      if (indentOf(raw) <= indent) break;
      const [, spaces = '', scope = '', rest = ''] = KEY.exec(raw) ?? [];
      const level = stripComment(rest);
      if (spaces.length !== indent + 2 || !(level in LEVEL))
        throw new Error(`${name}:${j + 1}: unreadable permission line "${raw.trim()}"`);
      perms[scope] = level;
    }
    return perms;
  };

  let sawJobs = false;
  lines.forEach((raw, i) => {
    const m = KEY.exec(raw);
    const structural = indentOf(raw) === 0 || (inJobs && indentOf(raw) === 2);
    if (!m && isContent(raw) && structural)
      throw new Error(`${name}:${i + 1}: unreadable line "${raw.trim()}"`);
    if (!m) return;
    const [, spaces = '', key = '', rest = ''] = m;
    const indent = spaces.length;
    const value = stripComment(rest);
    if (indent === 0) {
      sawJobs ||= key === 'jobs';
      inJobs = key === 'jobs';
      job = undefined;
      if (key === 'permissions') wf.perms = readPerms(i, 0, value);
    } else if (inJobs && indent === 2) {
      job = wf.jobs[key] = {};
    } else if (job && indent === 4) {
      if (key === 'permissions') job.perms = readPerms(i, 4, value);
      if (key === 'uses') job.uses = unquote(value);
    }
  });
  if (sawJobs && !Object.keys(wf.jobs).length)
    throw new Error(`${name}: no jobs read under jobs: — not a 2-space layout?`);
  return wf;
}

export interface Report {
  problems: string[];
  unchecked: string[]; // no permissions anywhere (the repo's default token), or a workflow in another repo
}

// `files` maps a workflow's file name (deploy.yml) to its text.
export function checkCallers(files: Record<string, string>): Report {
  const parsed = Object.fromEntries(
    Object.entries(files).map(([f, text]) => [f, parseWorkflow(text, f)]),
  );
  const report: Report = { problems: [], unchecked: [] };
  for (const [file, wf] of Object.entries(parsed)) {
    for (const [jobName, job] of Object.entries(wf.jobs)) {
      if (!job.uses) continue;
      const caller = `${file} › ${jobName}`;
      const target = job.uses.match(/^\.\/\.github\/workflows\/([^@\s/]+)$/)?.[1];
      if (!target) {
        if (job.uses.startsWith('./'))
          report.problems.push(`${caller} calls "${job.uses}", which isn't a local workflow file`);
        else report.unchecked.push(`${caller} (${job.uses})`);
        continue;
      }
      const called = parsed[target];
      if (!called) {
        report.problems.push(`${caller} calls ${target}, which doesn't exist`);
        continue;
      }
      const granted = job.perms ?? wf.perms;
      if (!granted) {
        report.unchecked.push(caller);
        continue;
      }
      const asks: [string, Perms | undefined][] = [
        [`${target} (top level)`, called.perms],
        ...Object.entries(called.jobs).map(([n, j]): [string, Perms | undefined] => [
          `${target} › ${n}`,
          j.perms,
        ]),
      ];
      for (const [where, perms] of asks) {
        for (const [scope, level] of Object.entries(perms ?? {})) {
          const has = granted[scope] ?? 'none';
          if ((LEVEL[has] ?? 0) < (LEVEL[level] ?? 0))
            report.problems.push(
              `${caller} grants ${scope}: ${has}, but ${where} declares ${scope}: ${level}`,
            );
        }
      }
    }
  }
  return report;
}
