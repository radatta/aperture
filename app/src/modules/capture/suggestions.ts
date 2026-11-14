import {
  DUE_TIME_PRESETS,
  duePresets,
  fmtClock12,
  fmtDayHeading,
  isDayKey,
} from '@aperture/shared';
import type { BulkLine, CaretToken } from '@aperture/shared';
import { fmtDuration } from '../../lib/format';

// Capture's token suggestion chips. A chip is a shortcut that types the literal token — the grammar is
// unchanged, and typing it by hand always works.
export interface Suggestion {
  key: string;
  label: string;
  a11y: string; // standalone name — "15m" or "Fri" alone means nothing to a screen reader
  insert: string; // the full token text that replaces the partial one
  // The token can continue (a day can take '@HH:MM'): no trailing space, caret at its end — so the next
  // chips (times) show at once. A space or the next token is the way past them.
  chain?: boolean;
}

export const ESTIMATE_PRESETS = [15, 30, 45, 60, 90, 120] as const;

// Word-start, case-insensitive: `#work` finds "Deep Work" (how you'd type it on a phone), but `#e`
// doesn't light up every label containing an e. A label with '"' can't be written in the grammar.
function categoryMatches<C extends { label: string }>(partial: string, cats: readonly C[]): C[] {
  const p = partial.toLowerCase();
  return cats
    .filter((c) => !c.label.includes('"'))
    .filter((c) => {
      const l = c.label.toLowerCase();
      // Whole-label prefix too, so a typed space ("deep w") still narrows.
      return l.startsWith(p) || l.split(/\s+/).some((w) => w.startsWith(p));
    });
}

export function categorySuggestions(
  partial: string,
  cats: readonly { id: string; label: string }[],
): Suggestion[] {
  return categoryMatches(partial, cats).map((c) => ({
    key: `c:${c.id}`,
    label: c.label,
    a11y: `Category ${c.label}`,
    insert: /\s/.test(c.label) ? `#"${c.label}"` : `#${c.label}`,
  }));
}

// A place by its link word or a word of its name: `@th` finds "Thrift Jo's" (slug `tj`) as well as a
// slug starting "th". The chip types the slug — the grammar's word.
function placeMatches<P extends { slug: string; name: string }>(
  partial: string,
  places: readonly P[],
): P[] {
  const p = partial.toLowerCase();
  return places.filter((x) => {
    const n = x.name.toLowerCase();
    return x.slug.startsWith(p) || n.startsWith(p) || n.split(/\s+/).some((w) => w.startsWith(p));
  });
}

export function placeSuggestions(
  partial: string,
  places: readonly { slug: string; name: string }[],
): Suggestion[] {
  return placeMatches(partial, places).map((x) => ({
    key: `p:${x.slug}`,
    label: `@${x.name}`,
    a11y: `Place ${x.name}`,
    insert: `@${x.slug}`,
  }));
}

export function estimateSuggestions(partial: string): Suggestion[] {
  return ESTIMATE_PRESETS.filter((m) => String(m).startsWith(partial)).map((m) => ({
    key: `e:${m}`,
    label: fmtDuration(m),
    a11y: `Estimate ${fmtDuration(m)}`,
    insert: `~${m}`,
  }));
}

// Day chips while the day is being typed; once it's a whole day (`due:2026-10-09`, caret at its end) or
// carries an '@', time chips — each types the full `due:<day>@HH:MM`.
export function dueSuggestions(partial: string, today: string): Suggestion[] {
  const at = partial.indexOf('@');
  const day = at === -1 ? partial : partial.slice(0, at);
  if (isDayKey(day) && (at !== -1 || partial === day)) {
    const typed = at === -1 ? '' : partial.slice(at + 1);
    return DUE_TIME_PRESETS.filter((t) => t.startsWith(typed)).map((t) => ({
      key: `t:${t}`,
      label: fmtClock12(t),
      a11y: `Due ${fmtDayHeading(day)} at ${fmtClock12(t)}`,
      insert: `due:${day}@${t}`,
    }));
  }
  return duePresets(today)
    .filter((p) => p.day.startsWith(partial))
    .map((p) => ({
      key: `d:${p.day}`,
      label: p.label,
      a11y: `Due ${fmtDayHeading(p.day)}`,
      insert: `due:${p.day}`,
      chain: true,
    }));
}

export function suggestionsFor(
  tok: CaretToken,
  ctx: {
    cats: readonly { id: string; label: string }[];
    places: readonly { slug: string; name: string }[];
    today: string;
  },
): Suggestion[] {
  if (tok.kind === 'category') return categorySuggestions(tok.partial, ctx.cats);
  if (tok.kind === 'place') return placeSuggestions(tok.partial, ctx.places);
  if (tok.kind === 'estimate') return estimateSuggestions(tok.partial);
  return dueSuggestions(tok.partial, ctx.today);
}

// Replace the whole token under the caret with the chip's text, then a space unless one already
// follows — so a mid-line accept doesn't leave a double space. The caret lands after it. A chaining
// chip (a day) gets no space and keeps the caret at the token's end, so its follow-up chips show.
export function applySuggestion(
  text: string,
  tok: CaretToken,
  s: Suggestion,
): { text: string; caret: number } {
  const after = text.slice(tok.replaceEnd);
  if (s.chain)
    return {
      text: text.slice(0, tok.replaceStart) + s.insert + after,
      caret: tok.replaceStart + s.insert.length,
    };
  const insert = /^\s/.test(after) ? s.insert : `${s.insert} `;
  const caret = tok.replaceStart + insert.length + (/^\s/.test(after) ? 1 : 0);
  return { text: text.slice(0, tok.replaceStart) + insert + after, caret };
}

// A half-typed #label or @place — it names nothing, but starts something (by the chips' own rule) — never
// drops quietly to "no category" / "off any list" on save. One match is taken, as Tab would take it; several
// are a red error until you pick. A token that starts nothing keeps its "created without one" warning.
// Called with the lists as loaded — an empty one (still loading) completes nothing.
export function completeTokens(
  line: BulkLine,
  cats: readonly { id: string; label: string }[],
  places: readonly { slug: string; name: string }[],
): BulkLine {
  const out = { ...line, errors: [...line.errors], errorKinds: [...line.errorKinds] };
  const failed = (kind: 'category' | 'place') => line.errorKinds.some((k) => k.kind === kind);
  if (out.categoryLabel !== null && out.categoryId === null && !failed('category')) {
    const typed = out.categoryLabel;
    const hits = categoryMatches(typed, cats);
    if (hits.length > 0) out.warnings = out.warnings.filter((w) => w !== noCategory(typed));
    if (hits.length === 1) {
      out.categoryId = hits[0]!.id;
      out.categoryLabel = hits[0]!.label;
    } else if (hits.length > 1) {
      out.errors.push(`#${typed} could be ${orList(hits.map((c) => c.label))} — pick one`);
      out.errorKinds.push({ kind: 'category' });
    }
  }
  if (out.placeSlug !== null && out.place === null && !failed('place')) {
    const typed = out.placeSlug;
    const hits = placeMatches(typed, places);
    if (hits.length > 0) out.warnings = out.warnings.filter((w) => w !== noPlace(typed));
    if (hits.length === 1) {
      out.place = hits[0]!.slug;
      out.placeSlug = hits[0]!.slug;
    } else if (hits.length > 1) {
      out.errors.push(`@${typed} could be ${orList(hits.map((p) => p.name))} — pick one`);
      out.errorKinds.push({ kind: 'place' });
    }
  }
  return out;
}

// The parser's own warnings for a token that matched nothing (bulkTasks.ts parseLine).
const noCategory = (label: string) => `no category '${label}' — created without one`;
const noPlace = (slug: string) => `no place '@${slug}' — created without one`;
const orList = (xs: string[]) =>
  xs.length <= 2 ? xs.join(' or ') : `${xs.slice(0, -1).join(', ')} or ${xs.at(-1)}`;
