// Capture modes. Log is the default and where the bar always returns after a submit.
export const CAPTURE_MODES = ['log', 'task', 'idea'] as const;
export type CaptureMode = (typeof CAPTURE_MODES)[number];

export function cycleMode(current: CaptureMode, dir: 1 | -1): CaptureMode {
  const i = CAPTURE_MODES.indexOf(current);
  const n = (i + dir + CAPTURE_MODES.length) % CAPTURE_MODES.length;
  return CAPTURE_MODES[n]!;
}

// Deliberately no structure prompts — just an invitation to type.
export function placeholderFor(mode: CaptureMode): string {
  switch (mode) {
    case 'log':
      return 'What happened?';
    case 'task':
      return 'New task…';
    case 'idea':
      return 'Capture an idea…';
  }
}

// The receipt shown after a submit. Capture is a trust exercise — you hand the app a thought and
// it disappears — so every submit says where the thought went, and links there.
export function receiptFor(mode: CaptureMode): { text: string; to: string; label: string } {
  switch (mode) {
    case 'log':
      return { text: 'Logged', to: '/log', label: 'today' };
    case 'task':
      return { text: 'Task added', to: '/tasks', label: 'backlog' };
    case 'idea':
      return { text: 'Captured', to: '/inbox', label: 'inbox' };
  }
}
