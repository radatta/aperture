import { useEffect, useRef } from 'react';
import { Outlet, useOutletContext, useSearchParams } from 'react-router';
import type { FinanceOverview } from '@aperture/shared';
import { EmptyState } from '../../components/EmptyState';
import { Text } from '../../components/Text';
import { AccountsStrip } from '../../modules/finances/AccountsStrip';
import { ConnectButton } from '../../modules/finances/ConnectButton';
import { PeriodHeader } from '../../modules/finances/PeriodHeader';
import { RulesSection } from '../../modules/finances/RulesSection';
import { SortQueue } from '../../modules/finances/SortQueue';
import { TransactionList } from '../../modules/finances/TransactionList';
import { useBankLink } from '../../modules/finances/useBankLink';
import { useFinanceData } from '../../modules/finances/useFinanceData';
import type { FinanceView } from '../../modules/finances/useFinanceData';
import { FinancesTabs } from './FinancesTabs';

interface FinancesOutlet {
  overview: FinanceOverview;
  view: FinanceView | null;
  pending: boolean;
  error: boolean;
}

// Finances (docs/areas/finances): the three-bucket budget over the synced bank. The header answers
// "how much of the budget is left this cycle"; the tabs are Sort (the batch queue), All (the ledger)
// and Rules. Tabs are real routes, like Recruiting.
export function FinancesPage() {
  const { overview, overviewQ, txnsQ, view } = useFinanceData();
  const link = useBankLink();
  useConnectFromUrl(link.start, overview !== undefined);

  const heading = (
    <Text as="h1" size="2xl" weight="semibold">
      Finances
    </Text>
  );

  if (!overview || overview.items.length === 0)
    return (
      <div className="flex flex-col gap-4">
        {heading}
        <EmptyState
          pending={overviewQ.isPending}
          error={overviewQ.isError}
          title="No bank connected."
          action={overview && <ConnectButton environment={overview.sync.environment} link={link} />}
        >
          Connect your bank once — checking, savings and the card — and charges sync four times a
          day. Then sort them into Parents pay, Budget, or I pay whenever suits you.
        </EmptyState>
        {link.error && (
          <Text size="sm" tone="danger">
            {link.error}
          </Text>
        )}
        {link.dialog}
      </div>
    );

  return (
    <div className="flex flex-col gap-4">
      {heading}
      <PeriodHeader overview={overview} view={view} />
      <AccountsStrip overview={overview} link={link} />
      <FinancesTabs />
      <Outlet
        context={
          {
            overview,
            view,
            pending: txnsQ.isPending,
            error: txnsQ.isError,
          } satisfies FinancesOutlet
        }
      />
      {link.dialog}
    </div>
  );
}

// /finances?link=connect — the installed-PWA Connect link opens this in a browser tab; start Link once
// the page has loaded, then drop the param so a reload doesn't start it again.
function useConnectFromUrl(start: ReturnType<typeof useBankLink>['start'], ready: boolean) {
  const [params, setParams] = useSearchParams();
  const started = useRef(false);
  useEffect(() => {
    if (!ready || started.current || params.get('link') !== 'connect') return;
    started.current = true;
    setParams({}, { replace: true });
    start({ mode: 'connect' });
  }, [ready, params, setParams, start]);
}

export function FinancesSortTab() {
  const { overview, view, pending, error } = useOutletContext<FinancesOutlet>();
  return <SortQueue overview={overview} view={view} pending={pending} error={error} />;
}

export function FinancesAllTab() {
  const { overview, view, pending, error } = useOutletContext<FinancesOutlet>();
  return <TransactionList overview={overview} view={view} pending={pending} error={error} />;
}

export function FinancesRulesTab() {
  return <RulesSection />;
}
