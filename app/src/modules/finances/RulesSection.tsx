import { useRef, useState } from 'react';
import {
  FINANCE_BUCKET_LABELS,
  FINANCE_BUCKETS,
  FINANCE_RULE_SPLIT_MAX_PARTS,
  financeRuleSplitError,
  normalizeRulePattern,
  ruleSplitBucket,
} from '@aperture/shared';
import type { FinanceBucket, FinanceRule, FinanceRuleSplitPart } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { Field } from '../../components/Field';
import { Menu } from '../../components/Menu';
import { Select } from '../../components/Select';
import { Text } from '../../components/Text';
import {
  useDeleteFinanceRule,
  useFinanceRules,
  useUpsertFinanceRule,
} from '../../data/hooks/useFinances';
import { ruleSplitText } from './amounts';

const BUCKET_OPTIONS = FINANCE_BUCKETS.map((b) => ({ value: b, label: FINANCE_BUCKET_LABELS[b] }));
const SPLIT = 'split'; // the "Sort into" choice that reveals percent parts
const SORT_OPTIONS = [...BUCKET_OPTIONS, { value: SPLIT, label: 'Split by percent…' }];

interface PercentDraft {
  key: number;
  bucket: FinanceBucket;
  percent: string;
}
const firstSplit = (): PercentDraft[] => [
  { key: 0, bucket: 'budget', percent: '50' },
  { key: 1, bucket: 'parents_pay', percent: '50' },
];
const wholePercent = (t: string): number | null => (/^\d{1,3}$/.test(t.trim()) ? Number(t) : null);

// "Always put X in Y". A rule sorts new charges as they sync (and, when saved from the sort queue,
// everything unsorted that matches). It never re-sorts a charge you already sorted by hand.
export function RulesSection() {
  const { data: rules = [], isPending, isError, refetch } = useFinanceRules();
  const upsert = useUpsertFinanceRule();
  const [pattern, setPattern] = useState('');
  const [bucket, setBucket] = useState<FinanceBucket | typeof SPLIT>('budget');
  const [parts, setParts] = useState<PercentDraft[]>(firstSplit);
  const nextKey = useRef(2);
  const [splitError, setSplitError] = useState<string | null>(null);
  const splitting = bucket === SPLIT;
  const percentSum = parts.reduce((n, p) => n + (wholePercent(p.percent) ?? 0), 0);
  const patternRef = useRef<HTMLInputElement>(null);
  // Adding a pattern that already has a rule updates it — say so, rather than silently re-sorting.
  const [note, setNote] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-3">
      {rules.length === 0 ? (
        <EmptyState
          pending={isPending}
          error={isError}
          onRetry={() => void refetch()}
          title="No rules yet."
        >
          Tick “Always” while sorting, or add one below. The longest matching text wins.
        </EmptyState>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {rules.map((r) => (
            <RuleRow key={r.id} rule={r} />
          ))}
        </ul>
      )}
      <Card>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (upsert.isPending || !pattern.trim()) return;
            const key = normalizeRulePattern(pattern);
            const existing = rules.find((r) => r.pattern === key);
            let split: FinanceRuleSplitPart[] | null = null;
            if (splitting) {
              split = [];
              for (const p of parts) {
                const percent = wholePercent(p.percent);
                if (percent === null)
                  return setSplitError('Each part needs a whole percent from 1 to 99');
                split.push({ bucket: p.bucket, percent });
              }
              const refusal = financeRuleSplitError(split);
              if (refusal) return setSplitError(refusal);
            }
            setSplitError(null);
            const target: FinanceBucket = split
              ? ruleSplitBucket(split)
              : (bucket as FinanceBucket);
            const name = split ? ruleSplitText(split) : FINANCE_BUCKET_LABELS[target];
            if (
              existing &&
              !split &&
              !existing.split &&
              existing.bucket === target &&
              existing.active
            ) {
              setNote(`“${key}” already sorts into ${name}.`);
              patternRef.current?.select(); // like a save: back in the field, ready to retype
              patternRef.current?.focus();
              return;
            }
            upsert.mutate(
              { pattern, bucket: target, split },
              {
                onSuccess: () => {
                  setPattern('');
                  const was = existing?.split
                    ? ruleSplitText(existing.split)
                    : existing
                      ? FINANCE_BUCKET_LABELS[existing.bucket]
                      : '';
                  setNote(
                    existing
                      ? `Updated “${key}”: ${name}` +
                          (was !== name ? ` (was ${was})` : '') +
                          (existing.active ? '.' : ' — resumed.')
                      : null,
                  );
                  patternRef.current?.focus(); // ready for the next one, wherever you submitted from
                },
              },
            );
          }}
        >
          <Field
            ref={patternRef}
            label="When the merchant contains"
            value={pattern}
            onChange={(e) => {
              setPattern(e.target.value);
              setNote(null);
            }}
            placeholder="uber eats"
            className="w-48"
          />
          <Select
            label="Sort into"
            value={bucket}
            onChange={(e) => {
              setBucket(e.target.value as FinanceBucket | typeof SPLIT);
              setNote(null);
              setSplitError(null);
            }}
            options={SORT_OPTIONS}
            className="w-44"
          />
          {splitting && (
            <fieldset className="flex basis-full flex-col gap-2">
              <legend className="sr-only">Split by percent</legend>
              {parts.map((p, i) => (
                <div key={p.key} className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label={`Part ${i + 1} bucket`}
                    value={p.bucket}
                    onChange={(e) => {
                      setSplitError(null); // a refusal was about the parts as they were
                      setParts((ps) =>
                        ps.map((x, j) =>
                          j === i ? { ...x, bucket: e.target.value as FinanceBucket } : x,
                        ),
                      );
                    }}
                    className="rounded-xl border border-line bg-surface px-2 py-1 text-ink outline-none focus:border-teal"
                  >
                    {BUCKET_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <span className="flex items-center gap-1">
                    <input
                      type="text"
                      inputMode="numeric"
                      aria-label={`Part ${i + 1} percent`}
                      value={p.percent}
                      onChange={(e) => {
                        setSplitError(null);
                        setParts((ps) =>
                          ps.map((x, j) => (j === i ? { ...x, percent: e.target.value } : x)),
                        );
                      }}
                      className="w-16 rounded-xl border border-line bg-surface px-2 py-1 text-right text-ink tabular-nums outline-none focus:border-teal"
                    />
                    <span aria-hidden className="text-ink-muted">
                      %
                    </span>
                  </span>
                  {parts.length > 2 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove part ${i + 1}`}
                      onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-3">
                <div role="status">
                  <Text size="sm" tone={percentSum > 100 ? 'danger' : 'muted'}>
                    {percentSum === 100
                      ? '100% assigned'
                      : percentSum < 100
                        ? `${100 - percentSum}% left to assign`
                        : `${percentSum - 100}% over`}
                  </Text>
                </div>
                {parts.length < FINANCE_RULE_SPLIT_MAX_PARTS && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setParts((ps) => {
                        const used = new Set(ps.map((x) => x.bucket));
                        const b = FINANCE_BUCKETS.find((x) => !used.has(x)) ?? 'budget';
                        return [...ps, { key: nextKey.current++, bucket: b, percent: '' }];
                      })
                    }
                  >
                    Add part
                  </Button>
                )}
              </div>
              <Text size="xs" tone="muted">
                New matching charges arrive split by these percents. Change one from its detail to
                split it differently.
              </Text>
            </fieldset>
          )}
          {/* Busy is aria-disabled, not disabled: a disabled button drops the focus it holds. */}
          <Button
            type="submit"
            size="sm"
            disabled={!pattern.trim()}
            aria-disabled={upsert.isPending || undefined}
          >
            Add rule
          </Button>
          {/* Always mounted: a live region announces text added to it, not a region that appears. */}
          <div role="status" className="basis-full empty:hidden">
            {note && (
              <Text size="sm" tone="muted">
                {note}
              </Text>
            )}
          </div>
          {(splitError ?? upsert.isError) && (
            <div role="alert" className="basis-full">
              <Text size="sm" tone="danger">
                {splitError ?? `Couldn’t save the rule: ${upsert.error!.message}`}
              </Text>
            </div>
          )}
        </form>
      </Card>
    </div>
  );
}

function RuleRow({ rule }: { rule: FinanceRule }) {
  const upsert = useUpsertFinanceRule();
  const del = useDeleteFinanceRule();
  return (
    <li className="flex items-center gap-3 py-2">
      <span className="flex min-w-0 flex-1 flex-col">
        <Text size="sm" tone={rule.active ? 'ink' : 'muted'} className="truncate">
          “{rule.pattern}”{rule.active ? '' : ' · paused'}
        </Text>
        {rule.split && (
          <Text size="xs" tone="muted">
            {ruleSplitText(rule.split)}
          </Text>
        )}
      </span>
      {/* Picking one bucket turns a split rule back into a one-bucket rule. */}
      <select
        aria-label={`Bucket for ${rule.pattern}`}
        value={rule.split ? SPLIT : rule.bucket}
        onChange={(e) =>
          upsert.mutate({
            id: rule.id,
            pattern: rule.pattern,
            bucket: e.target.value as FinanceBucket,
            active: rule.active,
            split: null,
          })
        }
        className="rounded-xl border border-line bg-surface px-2 py-1 text-ink outline-none focus:border-teal"
      >
        {rule.split && (
          <option value={SPLIT} disabled>
            Split
          </option>
        )}
        {BUCKET_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Menu
        label={`More actions for ${rule.pattern}`}
        items={[
          {
            label: rule.active ? 'Pause' : 'Resume',
            onSelect: () =>
              upsert.mutate({
                id: rule.id,
                pattern: rule.pattern,
                bucket: rule.bucket,
                active: !rule.active,
                split: rule.split,
              }),
          },
          { label: 'Delete', tone: 'danger', onSelect: () => del.mutate(rule.id) },
        ]}
      />
    </li>
  );
}
