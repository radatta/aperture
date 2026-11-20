import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { addDays, todayKey } from '@aperture/shared';
import type { ApiClient } from '@aperture/shared';
import { createStubClient } from '../../data/stubClient';
import { renderWithProviders } from '../../test/utils';
import { useSetCategoryArea } from '../../data/hooks/useCategories';
import { CalibrationSection } from './CalibrationSection';

// The lanes on the page (docs/areas/calibration/dev-lane.md): Aperture's dev work apart from the rest, and a
// backfilled ticket counted under its lane but never in the number or the Recent list.

beforeEach(() => globalThis.localStorage?.clear());

const stub = () => createStubClient({ seed: false, storageKey: `cal-${Math.random()}` });

async function finish(
  api: ApiClient,
  title: string,
  est: number,
  actual: number,
  categoryId?: string,
) {
  const t = await api.createTask({ title, estimateMin: est, categoryId: categoryId ?? null });
  await api.transitionTask(t.id, 'in_progress');
  await api.setTaskActual(t.id, actual);
  return api.transitionTask(t.id, 'done');
}
const lane = (name: string) => document.querySelector<HTMLElement>(`[data-lane="${name}"]`);

describe('CalibrationSection lanes', () => {
  it('with no Aperture point, one headline as it always was', async () => {
    const api = stub();
    await finish(api, 'Essay', 60, 90);
    renderWithProviders(<CalibrationSection />, { api });
    expect((await screen.findAllByText('+50%')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Aperture')).toBeNull();
    expect(screen.queryByText('Life')).toBeNull();
    expect(screen.getByText(/1 task · last 30 days/)).toBeTruthy();
  });

  it('an Aperture point splits the page: each lane its own number', async () => {
    const api = stub();
    const dev = await api.upsertCategory({ label: 'Dev', isWork: true, area: 'aperture' });
    await finish(api, 'Essay', 60, 90); // life +50%
    await finish(api, 'Ship it', 100, 50, dev.id); // aperture −50%
    renderWithProviders(<CalibrationSection />, { api });
    await screen.findByText('Aperture');
    expect(within(lane('life')!).getAllByText('+50%').length).toBeGreaterThan(0);
    expect(within(lane('aperture')!).getAllByText('-50%').length).toBeGreaterThan(0);
  });

  it('a backfilled ticket never moves the lane’s number, is counted apart, and stays out of Recent', async () => {
    const api = stub();
    const dev = await api.upsertCategory({ label: 'Dev', isWork: true, area: 'aperture' });
    await finish(api, 'Ship it', 100, 50, dev.id);
    const old = await api.createTask({ title: 'Old ticket', estimateMin: 10, categoryId: dev.id });
    const day = addDays(todayKey(4), -1);
    await api.backfillTasks([{ id: old.id, actualMin: 125, completedDay: day }]);
    renderWithProviders(<CalibrationSection />, { api });
    await screen.findByText('Aperture');
    const ap = lane('aperture')!;
    expect(within(ap).getAllByText('-50%').length).toBeGreaterThan(0);
    expect(within(ap).getByText(/1 task · last 30 days/)).toBeTruthy();
    expect(within(ap).getByText('1 backfilled · 2h 5m, not scored')).toBeTruthy();
    expect(screen.getAllByText('Ship it').length).toBeGreaterThan(0); // Recent
    expect(screen.queryByText('Old ticket')).toBeNull();
  });

  it('a lane of only backfilled tickets shows with nothing scored yet', async () => {
    const api = stub();
    const dev = await api.upsertCategory({ label: 'Dev', isWork: true, area: 'aperture' });
    await finish(api, 'Essay', 60, 90);
    const old = await api.createTask({ title: 'Old ticket', estimateMin: 10, categoryId: dev.id });
    await api.backfillTasks([{ id: old.id, actualMin: 30, completedDay: todayKey(4) }]);
    renderWithProviders(<CalibrationSection />, { api });
    await screen.findByText('Aperture');
    const ap = lane('aperture')!;
    expect(within(ap).getByText('Nothing scored yet.')).toBeTruthy();
    expect(within(ap).getByText('1 backfilled · 30m, not scored')).toBeTruthy();
    expect(within(lane('life')!).getAllByText('+50%').length).toBeGreaterThan(0);
  });

  it('moving the category out of Aperture regroups the page on the spot, not after the cache ages', async () => {
    const api = stub();
    const dev = await api.upsertCategory({ label: 'Dev', isWork: true, area: 'aperture' });
    await finish(api, 'Essay', 60, 90);
    await finish(api, 'Ship it', 100, 50, dev.id);
    function Move() {
      const move = useSetCategoryArea();
      return <button onClick={() => move.mutate({ id: dev.id, area: 'school' })}>move</button>;
    }
    renderWithProviders(
      <>
        <Move />
        <CalibrationSection />
      </>,
      { api },
    );
    await screen.findByText('Aperture');
    fireEvent.click(screen.getByText('move'));
    await waitFor(() => expect(lane('aperture')).toBeNull());
    expect(screen.getByText(/2 tasks · last 30 days/)).toBeTruthy();
  });
});
