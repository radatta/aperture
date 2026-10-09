import { useEffect, useState } from 'react';
import type { Euler } from '@aperture/shared/flux';
import type { EngineDebug } from './engine/engine';
import type { FluxEngineHandle } from './useFluxEngine';

// "Details": the instrument for checking Flux on a real device — which delegate is running, how fast,
// the raw and calibrated angles (to verify the yaw/roll sign convention), and frame/track health.
// Read-only numbers, collapsed by default, the same in every environment.

const POLL_MS = 500;
const deg = (e: Euler) => `${e.pitch.toFixed(1)} / ${e.yaw.toFixed(1)} / ${e.roll.toFixed(1)}`;

export function DebugReadout({ engine }: { engine: FluxEngineHandle }) {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<EngineDebug | null>(null);
  const { debug, sample, status } = engine;

  useEffect(() => {
    if (!open) return;
    const tick = () => setStats(debug());
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [open, debug]);

  const rows: [string, string][] = [
    ['status', status],
    ['delegate', stats?.delegate ?? '—'],
    ['fps', String(sample.fps)],
    ['face', sample.faceVisible ? 'yes' : 'no'],
    ['raw p/y/r', deg(sample.raw)],
    ['rel p/y/r', deg(sample.rel)],
    ['rom p/y/r', deg(sample.rom)],
    ['dropped frames', String(stats?.droppedFrames ?? 0)],
    ['GPU fallbacks', String(stats?.detectFailures ?? 0)],
    ['track', stats?.trackSize ?? '—'],
    ['visibility', typeof document === 'undefined' ? '—' : document.visibilityState],
  ];

  return (
    <details
      className="rounded-xl border border-line bg-panel px-3 py-2 text-sm"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="cursor-pointer text-ink-muted select-none">Details</summary>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 font-mono text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-muted">{k}</dt>
            <dd className="text-ink tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
