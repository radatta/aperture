import { useState } from 'react';
import type { Category } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Field } from '../../components/Field';
import { Menu } from '../../components/Menu';
import { Select } from '../../components/Select';
import { Text } from '../../components/Text';
import { ArrowDownIcon, ArrowUpIcon } from '../../components/icons';
import { useApi } from '../../data/api-context';
import {
  useCategories,
  useDeleteCategory,
  useSetCategoryWork,
  useUpsertCategory,
} from '../../data/hooks/useCategories';
import { useSettings, useUpdateSettings } from '../../data/hooks/useSettings';

// Settings (PRODUCT §4, §3, §A.4/§A.12): categories (id-referenced, live labels, reassign-on-delete,
// isWork backfill), preferences (day-start, pomodoro, theme), and data export.
export function SettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <Text as="h1" size="2xl" weight="semibold">
        Settings
      </Text>
      <CategoriesSection />
      <PreferencesSection />
      <DataSection />
    </div>
  );
}

function CategoriesSection() {
  const { data: cats = [] } = useCategories();
  const upsert = useUpsertCategory();
  const [label, setLabel] = useState('');
  const [isWork, setIsWork] = useState(true);

  return (
    <section className="flex flex-col gap-3">
      <Text size="sm" tone="muted" weight="medium" className="uppercase tracking-wider">
        Categories
      </Text>
      <div className="flex flex-col gap-2">
        {cats.map((c, i) => (
          <CategoryRow key={c.id} cat={c} cats={cats} index={i} />
        ))}
      </div>
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field
            label="New category"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Errands, Reading…"
            className="w-48"
          />
          <Select
            label="Type"
            value={isWork ? 'work' : 'non'}
            onChange={(e) => setIsWork(e.target.value === 'work')}
            options={[
              { value: 'work', label: 'Work' },
              { value: 'non', label: 'Non-work' },
            ]}
            className="w-32"
          />
          <Button
            size="sm"
            disabled={!label.trim() || upsert.isPending}
            onClick={async () => {
              await upsert.mutateAsync({ label: label.trim(), isWork });
              setLabel('');
            }}
          >
            Add
          </Button>
        </div>
      </Card>
    </section>
  );
}

type RowPanel = null | 'work' | 'delete';

function CategoryRow({ cat, cats, index }: { cat: Category; cats: Category[]; index: number }) {
  const upsert = useUpsertCategory();
  const setWork = useSetCategoryWork();
  const del = useDeleteCategory();
  const [panel, setPanel] = useState<RowPanel>(null);
  const [label, setLabel] = useState(cat.label);
  const others = cats.filter((c) => c.id !== cat.id);
  const [reassignTo, setReassignTo] = useState(others[0]?.id ?? '');
  const [backfilled, setBackfilled] = useState<number | null>(null);

  function move(dir: -1 | 1) {
    const swap = cats[index + dir];
    if (!swap) return;
    upsert.mutate({ id: cat.id, label: cat.label, isWork: cat.isWork, order: swap.order });
    upsert.mutate({ id: swap.id, label: swap.label, isWork: swap.isWork, order: cat.order });
  }

  async function flip(backfillPast: boolean) {
    const res = await setWork.mutateAsync({ id: cat.id, isWork: !cat.isWork, backfillPast });
    setBackfilled(backfillPast ? res.backfilled : null);
    setPanel(null);
  }

  return (
    <Card className="px-3.5 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {/* Borderless until you touch it — five bordered boxes stacked read as a form to fill in,
              when in fact these are already-set names you rarely rename. */}
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-label={`Rename ${cat.label}`}
            onBlur={() =>
              label.trim() &&
              label !== cat.label &&
              upsert.mutate({ id: cat.id, label: label.trim(), isWork: cat.isWork, order: cat.order })
            }
            className="w-40 rounded-lg border border-transparent bg-transparent px-2 py-1 text-ink outline-none transition hover:border-line focus:border-teal focus:bg-surface"
          />
          <Text size="xs" tone={cat.isWork ? 'teal' : 'subtle'}>
            {cat.isWork ? 'Work' : 'Non-work'}
          </Text>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {/* Arrows, not the words "Up"/"Down" — reordering is a nudge, not a sentence. */}
          <Button
            variant="quiet"
            size="sm"
            aria-label={`Move ${cat.label} up`}
            disabled={index === 0}
            onClick={() => move(-1)}
            className="px-2"
          >
            <ArrowUpIcon size={15} />
          </Button>
          <Button
            variant="quiet"
            size="sm"
            aria-label={`Move ${cat.label} down`}
            disabled={index === cats.length - 1}
            onClick={() => move(1)}
            className="px-2"
          >
            <ArrowDownIcon size={15} />
          </Button>
          <Menu
            label={`More actions for ${cat.label}`}
            items={[
              {
                label: `Make ${cat.isWork ? 'non-work' : 'work'}…`,
                onSelect: () => setPanel('work'),
              },
              ...(others.length > 0
                ? [{ label: 'Delete…', tone: 'danger' as const, onSelect: () => setPanel('delete') }]
                : []),
            ]}
          />
        </div>
      </div>

      {panel === 'work' && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3">
          <Text size="sm" tone="muted">
            Mark as {cat.isWork ? 'non-work' : 'work'}. Also reclassify past focus sessions?
          </Text>
          <Button size="sm" onClick={() => flip(false)}>
            Just going forward
          </Button>
          <Button variant="ghost" size="sm" onClick={() => flip(true)}>
            Reclassify past too
          </Button>
        </div>
      )}

      {panel === 'delete' && (
        <div className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-line bg-surface p-3">
          <Select
            label="Move its items to"
            value={reassignTo}
            onChange={(e) => setReassignTo(e.target.value)}
            options={others.map((c) => ({ value: c.id, label: c.label }))}
            className="w-44"
          />
          <Button
            variant="gold"
            size="sm"
            disabled={!reassignTo}
            onClick={() => {
              del.mutate({ id: cat.id, reassignToId: reassignTo });
              setPanel(null);
            }}
          >
            Delete
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setPanel(null)}>
            Cancel
          </Button>
        </div>
      )}

      {backfilled !== null && (
        <Text size="xs" tone="subtle" className="mt-2">
          Reclassified {backfilled} past {backfilled === 1 ? 'session' : 'sessions'}.
        </Text>
      )}
    </Card>
  );
}

function PreferencesSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  if (!settings) return null;
  return (
    <section className="flex flex-col gap-3">
      <Text size="sm" tone="muted" weight="medium" className="uppercase tracking-wider">
        Preferences
      </Text>
      <Card>
        <div className="flex flex-wrap items-end gap-4">
          <Field
            label="Day starts at (hour)"
            type="number"
            min={0}
            max={12}
            defaultValue={settings.dayStartHour}
            onBlur={(e) => update.mutate({ dayStartHour: Number(e.target.value) })}
            className="w-36"
          />
          <Field
            label="Pomodoro work (min)"
            type="number"
            min={1}
            defaultValue={settings.pomodoroWorkMin}
            onBlur={(e) => update.mutate({ pomodoroWorkMin: Number(e.target.value) })}
            className="w-36"
          />
          <Field
            label="Break (min)"
            type="number"
            min={1}
            defaultValue={settings.pomodoroBreakMin}
            onBlur={(e) => update.mutate({ pomodoroBreakMin: Number(e.target.value) })}
            className="w-28"
          />
          <Select
            label="Theme"
            value={settings.theme}
            onChange={(e) => update.mutate({ theme: e.target.value as 'auto' | 'light' | 'dark' })}
            options={[
              { value: 'auto', label: 'Auto (follows the mode)' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
            className="w-52"
          />
        </div>
      </Card>
    </section>
  );
}

function DataSection() {
  const api = useApi();
  async function exportJson() {
    const data = await api.exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'aperture-export.json';
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <section className="flex flex-col gap-3">
      <Text size="sm" tone="muted" weight="medium" className="uppercase tracking-wider">
        Data
      </Text>
      <Card>
        <div className="flex items-center justify-between gap-3">
          <Text size="sm" tone="muted">
            Your data is yours — export everything as JSON.
          </Text>
          <Button size="sm" onClick={exportJson}>
            Export JSON
          </Button>
        </div>
      </Card>
    </section>
  );
}
