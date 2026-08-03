// Rotating night-reflection prompts — a single question, non-cringe, fully skippable. Picked
// deterministically per day so it's stable across reloads but changes day to day.
export const REFLECTION_PROMPTS = [
  'What went better than you expected today?',
  'What did you underestimate?',
  'One thing worth doing again tomorrow?',
  'Where did your attention actually go?',
  'What drained you — and was it worth it?',
  'One small win you might otherwise forget?',
  'What did you put off, and why?',
] as const;

export function reflectionPromptFor(dayKey: string): string {
  let h = 0;
  for (const ch of dayKey) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return REFLECTION_PROMPTS[h % REFLECTION_PROMPTS.length]!;
}
