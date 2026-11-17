// `pnpm usage doctor`: is the meter logger installed and still writing? Pure checks over file contents the CLI reads.
// A COI restart can drop the `statusLine` key from ~/.claude/settings.json (docs/ops/USAGE-METER.md → Install),
// which stops the logger silently; this is the check that notices.

export interface DoctorInput {
  settings: string | null; // ~/.claude/settings.json
  statusline: string | null; // the script the statusLine command runs
  newestRowTs: string | null; // ts of the newest meter row
  now: number; // epoch ms
}
export interface Check {
  ok: boolean;
  what: string;
  fix?: string;
}

export const STALE_MIN = 10;
export const SOURCING_LINE =
  'for _s in /workspace/scripts/usage/statusline-log.sh /workspace/localNotes/usage/statusline-log.sh; do [ -r "$_s" ] && { . "$_s"; break; }; done; unset _s';

function statusLineKey(settings: string | null): boolean {
  if (!settings) return false;
  try {
    return Boolean(JSON.parse(settings)?.statusLine?.command);
  } catch {
    return false;
  }
}

export function doctor(i: DoctorInput): Check[] {
  const key = statusLineKey(i.settings);
  const sourced = !!i.statusline && /^[^#\n]*statusline-log\.sh/m.test(i.statusline);
  const ageMin = i.newestRowTs ? (i.now - Date.parse(i.newestRowTs)) / 60_000 : Infinity;
  return [
    {
      ok: key,
      what: 'settings.json has a statusLine command',
      fix: 'restore the statusLine key (docs/ops/USAGE-METER.md → Install, step 2)',
    },
    {
      ok: sourced,
      what: 'the status-line script sources statusline-log.sh',
      fix: `add to the status-line script: ${SOURCING_LINE}`,
    },
    {
      ok: ageMin < STALE_MIN,
      what: `the newest meter row is under ${STALE_MIN} min old`,
      fix: Number.isFinite(ageMin)
        ? `newest row is ${Math.round(ageMin)} min old: check the two lines above, then the log dir`
        : 'no meter rows yet: check the two lines above',
    },
  ].map((c) => (c.ok ? { ok: true, what: c.what } : c));
}

export const formatDoctor = (checks: Check[]) =>
  checks.map((c) => `${c.ok ? 'ok  ' : 'FAIL'} ${c.what}${c.fix ? `\n     → ${c.fix}` : ''}`).join('\n');
