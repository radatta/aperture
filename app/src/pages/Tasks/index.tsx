import { useEffect, useState } from 'react';
import { ModeToggle } from '../../components/ModeToggle';
import { Text } from '../../components/Text';
import { Button } from '../../components/Button';
import { PlusIcon } from '../../components/icons';
import { useDisclosure } from '../../lib/useDisclosure';
import { PlanSection } from '../../modules/tasks/PlanSection';
import { BacklogSection } from '../../modules/tasks/BacklogSection';
import { RecurringSection } from '../../modules/tasks/RecurringSection';
import { CalibrationSection } from '../../modules/calibration/CalibrationSection';
import { BulkAddDialog } from '../../modules/tasks/BulkAddDialog';

type Tab = 'plan' | 'backlog' | 'recurring' | 'calibration';

const TABS = [
  { value: 'plan' as const, label: 'Plan' },
  { value: 'backlog' as const, label: 'Backlog' },
  { value: 'recurring' as const, label: 'Recurring' },
  { value: 'calibration' as const, label: 'Calibration' },
];

const RECEIPT_MS = 2400;

// The tasks deep view (PRODUCT §4a). Plan = the morning pass (planned vs available); Backlog = manage
// what's in flight; Recurring = series templates; Calibration = the estimate-vs-actual evidence.
// Bulk add lives in the header (visible on every tab) — it's the batch-entry plan pass, not capture.
export function TasksPage() {
  const [tab, setTab] = useState<Tab>('plan');
  const bulk = useDisclosure();
  // `at` is a nonce so two adds in a row re-arm the fade (same trick as the capture receipt).
  const [receipt, setReceipt] = useState<{ count: number; at: number } | null>(null);

  useEffect(() => {
    if (!receipt) return;
    const id = setTimeout(() => setReceipt(null), RECEIPT_MS);
    return () => clearTimeout(id);
  }, [receipt]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Text as="h1" size="2xl" weight="semibold">
          Tasks
        </Text>
        <div className="flex items-center gap-3">
          {receipt && (
            <Text size="sm" tone="teal">
              Added {receipt.count} to Backlog
            </Text>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            ref={bulk.triggerRef}
            onClick={bulk.onOpen}
          >
            <PlusIcon size={14} /> Bulk add
          </Button>
          <ModeToggle<Tab> options={TABS} value={tab} onChange={setTab} />
        </div>
      </div>
      {tab === 'plan' && <PlanSection />}
      {tab === 'backlog' && <BacklogSection />}
      {tab === 'recurring' && <RecurringSection />}
      {tab === 'calibration' && <CalibrationSection />}
      <BulkAddDialog
        open={bulk.open}
        onClose={bulk.onClose}
        onAdded={(count) => setReceipt({ count, at: Date.now() })}
      />
    </div>
  );
}
