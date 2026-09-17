// Capture modes. Log is the default; after a submit the bar stays in whatever mode you're in.
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
// it vanishes from the field — so every submit says where the thought went.
export function receiptFor(mode: CaptureMode): { text: string; label: string } {
  switch (mode) {
    case 'log':
      return { text: 'Logged', label: 'today' };
    case 'task':
      return { text: 'Task added', label: 'backlog' };
    case 'idea':
      return { text: 'Captured', label: 'inbox' };
  }
}
