// The machine's throttle state in two lines (F120): the Mac's power (battery, Low Power Mode, thermal) and the
// heavy.sh slowdown ratio. `cli.ts machine` prints it for `board.sh status` / `json`, and `pnpm lanes status` adds the
// mac line, so the hub reads one rule in one place (docs/ops/HUB.md → The hub's duties → lanes on battery).
import { hhmm } from './tower/fmt.ts';
import { powerSummary, type MacRead, type PowerSummary } from './tower/health.ts';
import type { Job } from './tower/model.ts';
import { slowdown, type Slowdown } from './tower/slowdown.ts';

export type Machine = {
  mac: { state: MacRead['state']; power: PowerSummary };
  slowdown: Slowdown;
  lines: string[];
};

export function macLine(read: MacRead): string {
  const p = powerSummary(read);
  if (read.state === 'missing') return 'mac: no stats (agent not installed: tower NEEDS YOU)';
  if (read.state === 'bad') return `mac: stats unreadable${read.error ? ` (${read.error})` : ''}`;
  if (read.state === 'silent')
    return `mac: stats silent since ${read.at ? hhmm(read.at) : '?'} (asleep, or the agent stopped)`;
  if (!p.known) return 'mac: power unknown (an agent older than F120: reinstall, tower NEEDS YOU)';
  return `mac: ${p.line}${p.alerts.length ? ` — RED: ${p.alerts.join(', ')}` : ''}${p.advice ? ` — suggest ${p.advice}` : ''}${read.state === 'stale' ? ' (stale)' : ''}`;
}

export function machine(read: MacRead, jobs: Job[], now: number): Machine {
  const s = slowdown(jobs, now, hhmm);
  return {
    mac: { state: read.state, power: powerSummary(read) },
    slowdown: s,
    lines: [macLine(read), `slowdown (${s.windowMin} min vs 24 h): ${s.line}`],
  };
}
