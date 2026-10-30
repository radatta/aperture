import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import type { CalendarRef, Category, GoogleCalendar, Settings } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Field } from '../../components/Field';
import { Menu } from '../../components/Menu';
import { Select } from '../../components/Select';
import { Text } from '../../components/Text';
import { cx } from '../../lib/cx';
import { fmtDateTime } from '../../lib/format';
import { ArrowDownIcon, ArrowUpIcon } from '../../components/icons';
import { useApi } from '../../data/api-context';
import { BUILD_SHA } from '../../shared/env';
import {
  useCategories,
  useDeleteCategory,
  useSetCategoryWork,
  useUpsertCategory,
} from '../../data/hooks/useCategories';
import { useSettings, useUpdateSettings } from '../../data/hooks/useSettings';
import { fmtMoney, parseDollars } from '../../modules/finances/money';
import { useRolls } from '../../data/hooks/useRolls';
import {
  useConnectGoogle,
  useDisconnectGoogleAccount,
  useGoogleCalendars,
  useGoogleStatus,
} from '../../data/hooks/useCalendar';

// Settings (PRODUCT §4, §3, §A.4/§A.12): categories (id-referenced, live labels, reassign-on-delete,
// isWork backfill), preferences (day-start, pomodoro, theme), and data export.
export function SettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <Text as="h1" size="2xl" weight="semibold">
        Settings
      </Text>
      <CategoriesSection />
      <CalendarSection />
      <PreferencesSection />
      <FinancesSection />
      <FluxSection />
      <DataSection />
      {/* The visible build stamp — the iOS Simulator check reads it off the screen (docs/ops/DEV-CHECK.md). */}
      <Text size="xs" tone="muted" tabular>
        Build {BUILD_SHA.slice(0, 7)}
      </Text>
    </div>
  );
}

function CategoriesSection() {
  const { data: cats = [] } = useCategories();
  // Retired categories sort after the active ones; arrows reorder within a group only.
  const active = cats.filter((c) => c.active);
  const retired = cats.filter((c) => !c.active);
  const upsert = useUpsertCategory();
  const [label, setLabel] = useState('');
  const [isWork, setIsWork] = useState(true);

  return (
    <section className="flex flex-col gap-3">
      <Text size="sm" tone="muted" weight="medium" className="uppercase tracking-wider">
        Categories
      </Text>
      <div className="flex flex-col gap-2">
        {/* One list, not two maps: a row that retires/restores keeps its key, so it moves instead of
            remounting — focus and any half-typed rename survive. */}
        {[...active, ...retired].map((c) => {
          const siblings = c.active ? active : retired;
          return (
            <CategoryRow
              key={c.id}
              cat={c}
              cats={cats}
              siblings={siblings}
              index={siblings.indexOf(c)}
            />
          );
        })}
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

type RowPanel = null | 'work' | 'delete' | 'retire';

function CategoryRow({
  cat,
  cats,
  siblings,
  index,
}: {
  cat: Category;
  cats: Category[];
  siblings: Category[];
  index: number;
}) {
  const upsert = useUpsertCategory();
  const setWork = useSetCategoryWork();
  const del = useDeleteCategory();
  const [panel, setPanel] = useState<RowPanel>(null);
  const rowRef = useRef<HTMLDivElement>(null);

  // A collapsing panel unmounts the button that had focus; hand it back to the row's menu trigger.
  function closePanel() {
    setPanel(null);
    requestAnimationFrame(() =>
      rowRef.current?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')?.focus(),
    );
  }
  const [label, setLabel] = useState(cat.label);
  const others = cats.filter((c) => c.id !== cat.id);
  const [reassignTo, setReassignTo] = useState(
    (others.find((c) => c.active) ?? others[0])?.id ?? '',
  );
  const [backfilled, setBackfilled] = useState<number | null>(null);

  function move(dir: -1 | 1) {
    const swap = siblings[index + dir];
    if (!swap) return;
    upsert.mutate({
      id: cat.id,
      label: cat.label,
      isWork: cat.isWork,
      order: swap.order,
      active: cat.active,
    });
    upsert.mutate({
      id: swap.id,
      label: swap.label,
      isWork: swap.isWork,
      order: cat.order,
      active: swap.active,
    });
  }

  // Retire hides it from every picker; tasks keep the label. Restore brings it back. The row moves
  // between groups once the list refetches, and a moved DOM node drops focus — so refocus after that.
  function setActive(active: boolean) {
    upsert.mutate(
      { id: cat.id, label: cat.label, isWork: cat.isWork, order: cat.order, active },
      { onSuccess: closePanel },
    );
  }

  async function flip(backfillPast: boolean) {
    const res = await setWork.mutateAsync({ id: cat.id, isWork: !cat.isWork, backfillPast });
    setBackfilled(backfillPast ? res.backfilled : null);
    closePanel();
  }

  return (
    <Card className="px-3.5 py-2.5">
      <div ref={rowRef} className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {/* A faint resting border, not a full input box: five bordered boxes stacked read as a
              form to fill in, but hover-only would leave the field unmarked on touch — and this is
              an installable phone app. */}
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-label={`Rename ${cat.label}`}
            onBlur={() =>
              label.trim() &&
              label !== cat.label &&
              upsert.mutate({
                id: cat.id,
                label: label.trim(),
                isWork: cat.isWork,
                order: cat.order,
                active: cat.active,
              })
            }
            className={cx(
              'w-40 rounded-lg border border-line/60 bg-transparent px-2 py-1.5 outline-none transition hover:border-line-strong focus:border-teal focus:bg-surface',
              cat.active ? 'text-ink' : 'text-ink-muted',
            )}
          />
          {cat.active ? (
            <Text size="xs" tone={cat.isWork ? 'teal' : 'muted'}>
              {cat.isWork ? 'Work' : 'Non-work'}
            </Text>
          ) : (
            <Text size="xs" tone="muted">
              Retired
            </Text>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {/* Arrows, not the words "Up"/"Down" — reordering is a nudge, not a sentence. */}
          {cat.active && (
            <>
              <Button
                variant="quiet"
                size="sm"
                aria-label={`Move ${cat.label} up`}
                disabled={index === 0}
                onClick={() => move(-1)}
                className="h-9 w-9 px-0"
              >
                <ArrowUpIcon size={15} />
              </Button>
              <Button
                variant="quiet"
                size="sm"
                aria-label={`Move ${cat.label} down`}
                disabled={index === siblings.length - 1}
                onClick={() => move(1)}
                className="h-9 w-9 px-0"
              >
                <ArrowDownIcon size={15} />
              </Button>
            </>
          )}
          <Menu
            label={`More actions for ${cat.label}`}
            items={[
              {
                label: `Make ${cat.isWork ? 'non-work' : 'work'}…`,
                onSelect: () => setPanel('work'),
              },
              cat.active
                ? { label: 'Retire…', onSelect: () => setPanel('retire') }
                : { label: 'Restore', onSelect: () => setActive(true) },
              ...(others.length > 0
                ? [
                    {
                      label: 'Delete…',
                      tone: 'danger' as const,
                      onSelect: () => setPanel('delete'),
                    },
                  ]
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

      {panel === 'retire' && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3">
          <Text size="sm" tone="muted">
            Retire {cat.label}? Its tasks keep the label; it leaves the pickers. Restore any time.
          </Text>
          <Button size="sm" autoFocus onClick={() => setActive(false)}>
            Retire
          </Button>
          <Button variant="ghost" size="sm" onClick={() => closePanel()}>
            Cancel
          </Button>
        </div>
      )}

      {panel === 'delete' && (
        <div className="mt-3 flex flex-wrap items-end gap-2 rounded-xl border border-line bg-surface p-3">
          <Select
            label="Move its items to"
            value={reassignTo}
            onChange={(e) => setReassignTo(e.target.value)}
            options={others.map((c) => ({
              value: c.id,
              label: c.active ? c.label : `${c.label} (retired)`,
            }))}
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
          <Button variant="ghost" size="sm" onClick={() => closePanel()}>
            Cancel
          </Button>
        </div>
      )}

      {upsert.isError && (
        <Text size="xs" tone="danger" className="mt-2">
          Couldn't save that change — try again.
        </Text>
      )}

      {backfilled !== null && (
        <Text size="xs" tone="muted" className="mt-2">
          Reclassified {backfilled} past {backfilled === 1 ? 'session' : 'sessions'}.
        </Text>
      )}
    </Card>
  );
}

const sameRef = (a: CalendarRef, b: CalendarRef) =>
  a.accountSub === b.accountSub && a.calendarId === b.calendarId;

// Google Calendar: connected accounts (connect / add / disconnect), which calendars feed the day
// shape, the default write target, and the waking-hours window. Connecting is a browser redirect to
// Google's consent screen; disconnecting drops the account's token + its refs server-side.
function CalendarSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const { data: status } = useGoogleStatus();
  const connect = useConnectGoogle();
  const disconnect = useDisconnectGoogleAccount();
  const accounts = settings?.googleAccounts ?? [];
  const { data: calendars = [] } = useGoogleCalendars(accounts.length > 0);

  if (!settings) return null;

  const shapeRefs = settings.calendarShapeRefs;
  const inShape = (ref: CalendarRef) => shapeRefs.some((r) => sameRef(r, ref));
  const toggleShape = (ref: CalendarRef) =>
    update.mutate({
      calendarShapeRefs: inShape(ref)
        ? shapeRefs.filter((r) => !sameRef(r, ref))
        : [...shapeRefs, ref],
    });
  const statusFor = (sub: string) => status?.accounts.find((a) => a.sub === sub);

  return (
    <section className="flex flex-col gap-3">
      <Text size="sm" tone="muted" weight="medium" className="uppercase tracking-wider">
        Calendar
      </Text>

      <Card>
        <div className="flex flex-col gap-3">
          {accounts.length === 0 ? (
            <Text size="sm" tone="muted">
              Connect a Google account to read your calendars and add events from tasks.
            </Text>
          ) : (
            accounts.map((a) => {
              const st = statusFor(a.sub);
              return (
                <div key={a.sub} className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 flex-col">
                    <Text size="sm">{a.email}</Text>
                    {st?.reconnectRequired && (
                      <Text size="xs" tone="gold">
                        Needs reconnecting
                      </Text>
                    )}
                    {/* Two-way sync health: the last check for edits made in Google, or why it failed. */}
                    {settings.autoCalendar !== false &&
                      (st?.lastPullError ? (
                        <Text size="xs" tone="gold" className="break-words">
                          Couldn’t check for changes ({st.lastPullError}) — retries next time you
                          open the app
                        </Text>
                      ) : (
                        st?.lastSyncedAt && (
                          <Text size="xs" tone="muted">
                            Checked {fmtDateTime(st.lastSyncedAt)}
                          </Text>
                        )
                      ))}
                  </div>
                  <Button
                    variant="quiet"
                    size="sm"
                    disabled={disconnect.isPending}
                    onClick={() => disconnect.mutate(a.sub)}
                  >
                    Disconnect
                  </Button>
                </div>
              );
            })
          )}
          <div>
            <Button size="sm" disabled={connect.isPending} onClick={() => connect.mutate()}>
              {accounts.length === 0 ? 'Connect Google Calendar' : 'Add another account'}
            </Button>
          </div>
        </div>
      </Card>

      {accounts.length > 0 && (
        <Card>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Text size="sm" weight="medium">
                Calendars for your day shape
              </Text>
              {accounts.map((a) => (
                <div key={a.sub} className="flex flex-col gap-1">
                  <Text size="xs" tone="muted">
                    {a.email}
                  </Text>
                  {calendars
                    .filter((c) => c.accountSub === a.sub)
                    .map((c) => {
                      const ref = { accountSub: c.accountSub, calendarId: c.calendarId };
                      return (
                        <label key={c.calendarId} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={inShape(ref)}
                            onChange={() => toggleShape(ref)}
                          />
                          <Text size="sm">
                            {c.summary}
                            {c.primary ? ' (primary)' : ''}
                          </Text>
                        </label>
                      );
                    })}
                </div>
              ))}
            </div>

            <WriteDefaultPicker
              settings={settings}
              calendars={calendars}
              onChange={(ref) => update.mutate({ calendarWriteDefault: ref })}
            />

            {/* Auto-sync (docs/areas/calendar → Auto-sync). Needs a default calendar to write to; off
                leaves existing events where they are and stops syncing them. Old rows read undefined = on. */}
            <label className="flex items-start gap-2 has-[:disabled]:opacity-60">
              <input
                type="checkbox"
                className="mt-1"
                checked={!!settings.calendarWriteDefault && settings.autoCalendar !== false}
                disabled={!settings.calendarWriteDefault}
                onChange={(e) => update.mutate({ autoCalendar: e.target.checked })}
              />
              <span className="flex flex-col">
                <Text size="sm">Add tasks with a due time to this calendar automatically</Text>
                <Text size="xs" tone="muted">
                  The event ends at the deadline and lasts as long as the estimate (30 min if none).
                  Moving, renaming or re-estimating the task moves the event; clearing the time
                  removes it. Moving, resizing or renaming the event in Google Calendar updates the
                  task when you next open Aperture.
                </Text>
              </span>
            </label>

            <div className="flex flex-wrap items-end gap-4">
              <Field
                label="Waking hours start"
                type="number"
                min={0}
                max={23}
                defaultValue={settings.dayFocusStart}
                onBlur={(e) => update.mutate({ dayFocusStart: Number(e.target.value) })}
                className="w-36"
              />
              <Field
                label="Waking hours end"
                type="number"
                min={0}
                max={23}
                defaultValue={settings.dayEndHour}
                onBlur={(e) => update.mutate({ dayEndHour: Number(e.target.value) })}
                className="w-36"
              />
            </div>
          </div>
        </Card>
      )}
    </section>
  );
}

// The default calendar "add to calendar" writes to. Options are indexed (calendar ids aren't
// select-value-safe), plus a "no default" that forces a per-event pick.
function WriteDefaultPicker({
  settings,
  calendars,
  onChange,
}: {
  settings: Settings;
  calendars: GoogleCalendar[];
  onChange: (ref: CalendarRef | null) => void;
}) {
  const current = settings.calendarWriteDefault;
  const currentIdx = calendars.findIndex((c) => current && sameRef(c, current));
  return (
    <Select
      label="Add events to (default)"
      value={currentIdx >= 0 ? String(currentIdx) : ''}
      onChange={(e) => {
        const v = e.target.value;
        if (v === '') return onChange(null);
        const c = calendars[Number(v)]!;
        onChange({ accountSub: c.accountSub, calendarId: c.calendarId });
      }}
      options={[
        { value: '', label: 'No default (pick each time)' },
        ...calendars.map((c, i) => ({ value: String(i), label: c.summary })),
      ]}
      className="w-72"
    />
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
            className="w-60"
          />
        </div>
      </Card>
    </section>
  );
}

// The budget bucket's limit per billing period, and the card payment day the period falls back to
// until you mark a payment (finance.ts computeFinancePeriod). A bad value says so and isn't saved; it
// stays in the field so it can be fixed.
function FinancesSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const [budgetError, setBudgetError] = useState(false);
  const [dayError, setDayError] = useState(false);
  if (!settings) return null;
  return (
    <section className="flex flex-col gap-3">
      <Text size="sm" tone="muted" weight="medium" className="uppercase tracking-wider">
        Finances
      </Text>
      <Card>
        <div className="flex flex-wrap items-end gap-4">
          <Field
            label="Budget per period ($)"
            inputMode="decimal"
            defaultValue={(settings.financeBudgetCents / 100).toFixed(2)}
            onBlur={(e) => {
              const cents = parseDollars(e.target.value);
              setBudgetError(cents === null);
              if (cents !== null && cents !== settings.financeBudgetCents)
                update.mutate({ financeBudgetCents: cents });
            }}
            aria-invalid={budgetError}
            aria-describedby={budgetError ? 'fin-budget-error' : undefined}
            className="w-36"
          />
          <Field
            label="Card payment day"
            type="number"
            min={1}
            max={31}
            defaultValue={settings.financePaymentDay}
            onBlur={(e) => {
              const raw = e.target.value.trim();
              const day = Number(raw);
              const ok = raw !== '' && Number.isInteger(day) && day >= 1 && day <= 31;
              setDayError(!ok);
              if (ok && day !== settings.financePaymentDay)
                update.mutate({ financePaymentDay: day });
            }}
            aria-invalid={dayError}
            aria-describedby={dayError ? 'fin-day-error' : undefined}
            className="w-36"
          />
        </div>
        {budgetError && (
          <div role="alert" className="mt-2">
            <Text id="fin-budget-error" size="xs" tone="danger">
              Enter a dollar amount, like 600 or 600.00.
            </Text>
          </div>
        )}
        {dayError && (
          <div role="alert" className="mt-2">
            <Text id="fin-day-error" size="xs" tone="danger">
              Enter a day from 1 to 31.
            </Text>
          </div>
        )}
        <Text size="xs" tone="muted" className="mt-2 block">
          Now {fmtMoney(settings.financeBudgetCents)}, payment day {settings.financePaymentDay}. The
          payment day is used until you mark a payment — the period starts the day after it.
        </Text>
      </Card>
    </section>
  );
}

// Flux (docs/areas/flux): which Roll a Flux session counts toward, and the disclaimer reset. Both are
// synced Settings fields; Flux's voice and chips are per device and live on the Flux page.
function FluxSection() {
  const { data: settings } = useSettings();
  const { data: rolls = [] } = useRolls();
  const update = useUpdateSettings();
  const { hash } = useLocation();
  const sectionRef = useRef<HTMLElement>(null);
  const loaded = !!settings;
  // Flux's "link a Roll" note deep-links to /settings#flux; the section only exists once settings
  // load, so the browser's own anchor jump misses it.
  useEffect(() => {
    if (loaded && hash === '#flux') sectionRef.current?.scrollIntoView?.({ block: 'start' });
  }, [loaded, hash]);
  if (!settings) return null;
  const active = rolls.filter((r) => r.active);
  return (
    <section ref={sectionRef} id="flux" className="flex flex-col gap-3">
      <Text size="sm" tone="muted" weight="medium" className="uppercase tracking-wider">
        Flux
      </Text>
      <Card className="flex flex-col gap-3">
        <Select
          label="Count sessions as reps of"
          value={
            active.some((r) => r.id === settings.fluxRollId) ? (settings.fluxRollId ?? '') : ''
          }
          onChange={(e) => update.mutate({ fluxRollId: e.target.value || null })}
          placeholder="No Roll"
          options={active.map((r) => ({ value: r.id, label: r.name }))}
          className="w-60"
        />
        <Text size="xs" tone="muted">
          The first set of a session (one stopped early too) starts that Roll&apos;s rep for today;
          stopping offers to log it with the session&apos;s minutes.
          {active.length === 0 && ' Add a Roll on the Rolls page first.'}
        </Text>
        {settings.fluxDisclaimerAckAt !== null && (
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => update.mutate({ fluxDisclaimerAckAt: null })}
            >
              Show the Flux disclaimer again
            </Button>
          </div>
        )}
        {update.isError && (
          <p role="alert" className="text-xs text-danger">
            Couldn&apos;t save that — try again.
          </p>
        )}
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
