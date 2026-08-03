import { useState } from 'react';
import { ModeToggle } from '../../components/ModeToggle';
import { Text } from '../../components/Text';
import { PlanSection } from '../../modules/tasks/PlanSection';
import { BacklogSection } from '../../modules/tasks/BacklogSection';
import { RecurringSection } from '../../modules/tasks/RecurringSection';
import { CalibrationSection } from '../../modules/calibration/CalibrationSection';

type Tab = 'plan' | 'backlog' | 'recurring' | 'calibration';

const TABS = [
  { value: 'plan' as const, label: 'Plan' },
  { value: 'backlog' as const, label: 'Backlog' },
  { value: 'recurring' as const, label: 'Recurring' },
  { value: 'calibration' as const, label: 'Calibration' },
];

// The tasks deep view (PRODUCT §4a). Plan = the morning pass (planned vs available); Backlog = manage
// what's in flight; Recurring = series templates; Calibration = the estimate-vs-actual evidence.
export function TasksPage() {
  const [tab, setTab] = useState<Tab>('plan');
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Text as="h1" size="2xl" weight="semibold">
          Tasks
        </Text>
        <ModeToggle<Tab> options={TABS} value={tab} onChange={setTab} />
      </div>
      {tab === 'plan' && <PlanSection />}
      {tab === 'backlog' && <BacklogSection />}
      {tab === 'recurring' && <RecurringSection />}
      {tab === 'calibration' && <CalibrationSection />}
    </div>
  );
}
