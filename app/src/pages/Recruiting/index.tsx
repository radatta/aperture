import { Outlet } from 'react-router';
import { Text } from '../../components/Text';
import { RecruitingTabs } from './RecruitingTabs';

// Recruiting is a two-tab hub: Attempts (LeetCode capture, read-only, fed by the extension) and Stories
// (the behavioral story bank, authored here). The tabs are real routes — /recruiting and
// /recruiting/stories — so each is linkable and back/forward works; the shell renders the active one
// through the Outlet.
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
