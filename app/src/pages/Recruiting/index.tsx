import { Outlet } from 'react-router';
import { Text } from '../../components/Text';
import { RecruitingTabs } from './RecruitingTabs';

// Recruiting is a four-tab hub: Sittings (LeetCode, captured by the extension), Patterns (how each
// pattern's practice is going, and the coach's focus), Progress (how much of the list is done, every solve, the
// trends) and Stories (the behavioral story bank, authored here). The tabs are real routes — /recruiting,
// /recruiting/patterns, /recruiting/progress and /recruiting/stories — so each is linkable and back/forward works;
// the shell renders the active one through the Outlet.
export function RecruitingPage() {
  return (
    <div className="flex flex-col gap-4">
      <Text as="h1" size="2xl" weight="semibold">
        Recruiting
      </Text>
      <RecruitingTabs />
      <Outlet />
    </div>
  );
}
