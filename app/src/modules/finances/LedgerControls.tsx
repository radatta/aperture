import { forwardRef } from 'react';
import { FINANCE_BUCKET_LABELS, FINANCE_BUCKETS } from '@aperture/shared';
import type { FinanceBucket, FinanceListFilter } from '@aperture/shared';
import { Text } from '../../components/Text';
import { cx } from '../../lib/cx';
import { bucketToneClass } from './bucketStyles';
import { fmtSigned } from './money';

const FILTERS: { value: FinanceListFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'unsorted', label: 'Unsorted' },
  ...FINANCE_BUCKETS.map((b) => ({ value: b, label: FINANCE_BUCKET_LABELS[b] })),
];

export const BRUSH_HINT_ID = 'ledger-brush-hint';

// The armed hint's ground: the bucket's soft fill (text stays `ink` on it, like BucketTag); Not spending
// has no colour of its own, so it gets the neutral panel.
const HINT_TONE: Record<FinanceBucket, string> = {
  parents_pay: 'border-teal bg-teal-soft',
  budget: 'border-gold bg-gold-soft',
  i_pay: 'border-line-strong bg-panel-2',
  not_spending: 'border-line-strong bg-panel-2',
};

// "Sort into": arm a bucket, then tap rows to sort them. Toggles, not radios — "none" is a state, and
// arrowing through radios would arm each on the way. Squared buttons with a key number, unlike the
// round Show chips below, so the two bucket-named rows never read as one control. Sticky while armed,
// with a fixed-height hint line so arming never shifts the list.
export function BrushPicker({
  brush,
  onToggle,
  onDone,
  toggleRefs,
}: {
  brush: FinanceBucket | null;
  onToggle: (b: FinanceBucket) => void;
  onDone: () => void;
  toggleRefs: React.MutableRefObject<Map<FinanceBucket, HTMLButtonElement>>;
}) {
  return (
    <div
      // Padding and border always on (only their colour and `sticky` switch), so arming never shifts
      // the list.
      className={cx(
        '-mx-4 flex flex-col gap-2 border-b px-4 py-2 sm:mx-0 sm:px-0',
        brush ? 'sticky top-0 z-10 border-line bg-surface' : 'border-transparent',
      )}
    >
      <div role="group" aria-label="Sort into" className="flex flex-col gap-1.5">
        <Text as="span" size="xs" tone="muted" weight="medium" className="uppercase tracking-wider">
          Sort into
        </Text>
        <div className="grid grid-cols-4 gap-1.5 sm:flex sm:flex-wrap">
          {FINANCE_BUCKETS.map((b, i) => (
            <button
              key={b}
              ref={(el) => {
                if (el) toggleRefs.current.set(b, el);
                else toggleRefs.current.delete(b);
              }}
              type="button"
              aria-pressed={brush === b}
              aria-keyshortcuts={String(i + 1)}
              onClick={() => onToggle(b)}
              className={cx(
                'flex min-h-11 items-center justify-center gap-1.5 rounded-lg border px-2 py-1 text-sm transition sm:justify-start sm:px-3',
                brush === b
                  ? cx(bucketToneClass[b], 'ring-2 ring-teal')
                  : 'border-line text-ink-muted hover:text-ink',
              )}
            >
              {/* aria-keyshortcuts carries the key; the digit is for the eye. On a soft fill the
                  text stays `ink` (colour tiers). */}
              <kbd
                aria-hidden
                className={cx('font-sans text-xs', brush === b ? 'text-ink' : 'text-ink-muted')}
              >
                {i + 1}
              </kbd>
              <span className="text-center leading-tight">{FINANCE_BUCKET_LABELS[b]}</span>
            </button>
          ))}
        </div>
      </div>
      <div
        className={cx(
          'flex min-h-9 items-center gap-3 rounded-lg px-3 text-sm',
          brush ? cx(HINT_TONE[brush], 'border text-ink') : 'text-ink-muted',
        )}
      >
        <span id={BRUSH_HINT_ID} className="flex-1">
          {brush ? (
            <>
              Sorting into <strong className="font-semibold">{FINANCE_BUCKET_LABELS[brush]}</strong>{' '}
              · tap rows
              {/* Phones have no Esc (Done is there); keep the line to one row so arming never shifts. */}
              <span className="hidden sm:inline"> · Esc to stop</span>
            </>
          ) : (
            'Pick one, then tap rows to sort them.'
          )}
        </span>
        {brush && (
          <button
            type="button"
            aria-keyshortcuts="Escape"
            data-brush-done
            onClick={onDone}
            className="rounded-md px-2 py-1 font-medium text-ink hover:bg-panel-2"
          >
            Done
          </button>
        )}
      </div>
    </div>
  );
}

export const SearchBox = forwardRef<
  HTMLInputElement,
  {
    value: string;
    onChange: (v: string) => void;
    label?: string;
    placeholder?: string;
    keyshortcut?: string | null; // null: no shortcut focuses it
    onPanel?: boolean; // inside a modal: the field's own ground, like Field
  }
>(function SearchBox(
  {
    value,
    onChange,
    label = 'Search transactions',
    placeholder = 'Search merchant, bank text or note  ( / )',
    keyshortcut = '/',
    onPanel = false,
  },
  ref,
) {
  return (
    <input
      ref={ref}
      type="search"
      value={value}
      aria-label={label}
      aria-keyshortcuts={keyshortcut ?? undefined}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        // Escape clears first; on an empty box it falls through (disarms the brush, closes a dialog).
        if (e.key === 'Escape' && value !== '') {
          e.preventDefault();
          onChange('');
        }
      }}
      className={cx(
        'w-full rounded-lg border border-line px-3 py-2 text-sm text-ink placeholder:text-ink-muted focus:border-teal focus:outline-none',
        onPanel ? 'bg-surface' : 'bg-panel',
      )}
    />
  );
});

export function ShowChips({
  filter,
  onChange,
}: {
  filter: FinanceListFilter;
  onChange: (f: FinanceListFilter) => void;
}) {
  return (
    <div role="group" aria-label="Show" className="flex flex-wrap items-center gap-1.5">
      <Text
        as="span"
        size="xs"
        tone="muted"
        weight="medium"
        className="mr-1 uppercase tracking-wider"
      >
        Show
      </Text>
      {FILTERS.map((f) => (
        <button
          key={f.value}
          type="button"
          aria-pressed={filter === f.value}
          onClick={() => onChange(f.value)}
          className={cx(
            'shrink-0 rounded-full border px-3 py-1 text-sm transition',
            filter === f.value
              ? 'border-teal bg-teal-soft text-ink'
              : 'border-line text-ink-muted hover:text-ink',
          )}
        >
          {f.label}
        </button>
      ))}
    </div>
  );
}

// What's shown, counted and totalled (net — money in subtracts, like the MCP's totalUsd).
export function ListSummary({ count, cents }: { count: number; cents: number }) {
  return (
    <Text size="sm" tone="muted" tabular>
      {count} {count === 1 ? 'row' : 'rows'} · {fmtSigned(cents)}
    </Text>
  );
}
