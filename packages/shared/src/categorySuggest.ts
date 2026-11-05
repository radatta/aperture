// A confident-only category suggestion for an uncategorised task, scored from the user's own
// categorised tasks: naive Bayes over the words of title + notes, with a log prior and add-0.5
// smoothing. It is not a classifier — measured on prod 2026-11-05 (187 tasks, 142 categorised),
// top-1 ungated was 63%, no better than always naming the biggest category; gated to a 2-nat margin
// it spoke on 46% of tasks at 92% precision. So below the gates it says nothing, and the chip that
// shows it is tap-only: a wrong accept costs what a wrong manual pick does, never an auto-assign.
// docs/areas/tasks/task-editor.md → Category suggestion.
import type { Category, Task } from './types';

export const SUGGEST_MIN_HISTORY = 20; // categorised tasks in play before any suggestion
export const SUGGEST_MIN_EXAMPLES = 3; // tasks the winning category must already hold
export const SUGGEST_MIN_MARGIN = 2; // nats between the best and the runner-up
const NOTES_CHARS = 200;

export interface CategorySuggestion {
  categoryId: string;
  margin: number; // nats; ≥ SUGGEST_MIN_MARGIN
}

export type SuggestableTask = Pick<Task, 'title'> & { id?: string; notes?: string | null };
type HistoryTask = Pick<Task, 'id' | 'title' | 'categoryId'> & { notes?: string | null };

// The words a task is judged by: `[a-z0-9]{2,}` runs of the title and the first 200 chars of notes,
// each counted once per task (a word repeated in one task is still one piece of evidence).
export function suggestionTokens(title: string, notes?: string | null): Set<string> {
  const text = `${title} ${(notes ?? '').slice(0, NOTES_CHARS)}`.toLowerCase();
  return new Set(text.match(/[a-z0-9]{2,}/g) ?? []);
}

interface Stats {
  docs: number;
  df: Map<string, number>; // tasks in this category carrying the word
}

export function suggestCategory(
  task: SuggestableTask,
  history: readonly HistoryTask[],
  categories: readonly Pick<Category, 'id' | 'active'>[],
): CategorySuggestion | null {
  const active = new Set(categories.filter((c) => c.active).map((c) => c.id));
  // Active categories only (a retired one leaves every picker), and never the task's own row.
  const docs = history.filter(
    (t) => t.id !== task.id && t.categoryId !== null && active.has(t.categoryId),
  );
  if (docs.length < SUGGEST_MIN_HISTORY) return null;

  const stats = new Map<string, Stats>();
  const vocab = new Set<string>();
  for (const t of docs) {
    const s = stats.get(t.categoryId!) ?? { docs: 0, df: new Map() };
    s.docs += 1;
    for (const w of suggestionTokens(t.title, t.notes)) {
      s.df.set(w, (s.df.get(w) ?? 0) + 1);
      vocab.add(w);
    }
    stats.set(t.categoryId!, s);
  }
  if (stats.size < 2) return null; // one category is no evidence for it over anything else

  // Words nobody has used yet say nothing about where this task belongs.
  const terms = [...suggestionTokens(task.title, task.notes)].filter((w) => vocab.has(w));
  if (terms.length === 0) return null;

  const scored = [...stats].map(([categoryId, s]) => {
    let score = Math.log(s.docs / docs.length);
    for (const w of terms) score += Math.log(((s.df.get(w) ?? 0) + 0.5) / (s.docs + 1));
    return { categoryId, score, docs: s.docs };
  });
  scored.sort((a, b) => b.score - a.score);
  const [best, next] = scored as [(typeof scored)[number], (typeof scored)[number]];
  const margin = best.score - next.score;
  if (best.docs < SUGGEST_MIN_EXAMPLES || margin < SUGGEST_MIN_MARGIN) return null;
  return { categoryId: best.categoryId, margin };
}
