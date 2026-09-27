import { useState } from 'react';
import { FINANCE_BUCKET_LABELS, FINANCE_BUCKETS } from '@aperture/shared';
import type { FinanceBucket, FinanceRule } from '@aperture/shared';
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

const BUCKET_OPTIONS = FINANCE_BUCKETS.map((b) => ({ value: b, label: FINANCE_BUCKET_LABELS[b] }));

// "Always put X in Y". A rule sorts new charges as they sync (and, when saved from the sort queue,
// everything unsorted that matches). It never re-sorts a charge you already sorted by hand.
export function RulesSection() {
  const { data: rules = [], isPending, isError } = useFinanceRules();
  const upsert = useUpsertFinanceRule();
  const [pattern, setPattern] = useState('');
  const [bucket, setBucket] = useState<FinanceBucket>('budget');

  return (
    <div className="flex flex-col gap-3">
      {rules.length === 0 ? (
        <EmptyState pending={isPending} error={isError} title="No rules yet.">
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
          onSubmit={async (e) => {
            e.preventDefault();
            await upsert.mutateAsync({ pattern, bucket });
            setPattern('');
          }}
        >
          <Field
            label="When the merchant contains"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="uber eats"
            className="w-48"
          />
          <Select
            label="Sort into"
            value={bucket}
            onChange={(e) => setBucket(e.target.value as FinanceBucket)}
            options={BUCKET_OPTIONS}
            className="w-36"
          />
          <Button type="submit" size="sm" disabled={!pattern.trim() || upsert.isPending}>
            Add rule
          </Button>
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
      <Text size="sm" tone={rule.active ? 'ink' : 'muted'} className="min-w-0 flex-1 truncate">
        “{rule.pattern}”{rule.active ? '' : ' · paused'}
      </Text>
      <select
        aria-label={`Bucket for ${rule.pattern}`}
        value={rule.bucket}
        onChange={(e) =>
          upsert.mutate({
            id: rule.id,
            pattern: rule.pattern,
            bucket: e.target.value as FinanceBucket,
            active: rule.active,
          })
        }
        className="rounded-xl border border-line bg-surface px-2 py-1 text-sm text-ink outline-none focus:border-teal"
      >
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
              }),
          },
          { label: 'Delete', tone: 'danger', onSelect: () => del.mutate(rule.id) },
        ]}
      />
    </li>
  );
}
