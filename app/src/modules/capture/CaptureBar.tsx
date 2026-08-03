import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { todayKey } from '@aperture/shared';
import { cx } from '../../lib/cx';
import { ModeToggle } from '../../components/ModeToggle';
import { useSettings } from '../../data/hooks/useSettings';
import { useCreateLogEntry } from '../../data/hooks/useLog';
import { useCreateTask } from '../../data/hooks/useTasks';
import { useCreateIdea } from '../../data/hooks/useIdeas';
import { CAPTURE_MODES, cycleMode, placeholderFor, type CaptureMode } from './mode';

// The global capture bar — PRODUCT's #1 mechanic. Always present, bottom-fixed for thumb reach.
// Default Log; Tab cycles the mode; Enter submits; after submit it clears, stays focused, and snaps
// back to Log. It never asks for structure — no estimate/category/due field exists here by design.
export function CaptureBar() {
  const { data: settings } = useSettings();
  const today = todayKey(settings?.dayStartHour ?? 4);
  const [mode, setMode] = useState<CaptureMode>('log');
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const createLog = useCreateLogEntry(today);
  const createTask = useCreateTask();
  const createIdea = useCreateIdea();

  // "/" focuses capture from anywhere, unless you're already typing.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key !== '/') return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      inputRef.current?.focus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function submit() {
    const value = text.trim();
    if (!value) return;
    if (mode === 'log') createLog.mutate(value);
    else if (mode === 'task') createTask.mutate(value);
    else createIdea.mutate(value);
    setText('');
    setMode('log');
    inputRef.current?.focus();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      setMode((m) => cycleMode(m, e.shiftKey ? -1 : 1));
    } else if (e.key === 'Escape') {
      inputRef.current?.blur();
    }
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-4">
      <div className="flex w-full max-w-2xl items-center gap-2 rounded-2xl border border-line bg-panel-2 p-2 shadow-lg">
        <ModeToggle<CaptureMode>
          options={CAPTURE_MODES.map((m) => ({ value: m, label: m[0]!.toUpperCase() + m.slice(1) }))}
          value={mode}
          onChange={setMode}
        />
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholderFor(mode)}
          aria-label={`Capture ${mode}`}
          className={cx(
            'min-w-0 flex-1 bg-transparent px-2 py-2 text-ink outline-none',
            'placeholder:text-ink-subtle',
          )}
        />
      </div>
    </div>
  );
}
