import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AUTH_HEADER, PLACE_TOKEN_PREFIX, PLACE_TOKEN_RACE_ERROR } from '@aperture/shared';
import { createStubClient } from '../../data/stubClient';
import { renderWithProviders } from '../../test/utils';
import { PlacesSection } from './PlacesSection';

beforeEach(() => globalThis.localStorage?.clear());

const stub = () => createStubClient({ seed: false, storageKey: `places-${Math.random()}` });

async function twoPlaces() {
  const api = stub();
  const corner = await api.upsertPlace({ name: 'Corner Shop', slug: 'corner' });
  const market = await api.upsertPlace({ name: 'Market' });
  return { api, corner, market };
}

const row = (name: string) =>
  screen.getByLabelText(`Rename ${name}`).closest<HTMLElement>('.rounded-2xl')!;

describe('Settings › Places: the list', () => {
  it('starts empty with an invitation — no default store offered', async () => {
    renderWithProviders(<PlacesSection />, { api: stub() });
    await screen.findByText(/No places yet — add the stores you run errands at/);
    expect(screen.queryByRole('button', { name: /Grocer/i })).toBeNull();
  });

  it('adds a place, showing its link word as you type, and refuses a clash before sending', async () => {
    const { api } = await twoPlaces();
    const user = userEvent.setup();
    renderWithProviders(<PlacesSection />, { api });
    await screen.findByLabelText('Rename Market');
    const field = screen.getByLabelText('New place');
    await user.type(field, 'market');
    expect(screen.getByText('Another place already uses "market"')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add place' }).disabled).toBe(
      true,
    );

    await user.clear(field);
    await user.type(field, "Thrift Jo's");
    expect(screen.getByText('Link word: @thrift-jo-s')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add place' }));
    await waitFor(async () =>
      expect((await api.listPlaces()).map((p) => p.slug)).toEqual([
        'corner',
        'market',
        'thrift-jo-s',
      ]),
    );
    expect(await screen.findByLabelText("Rename Thrift Jo's")).toBeTruthy();
    expect((field as HTMLInputElement).value).toBe('');
  });

  it('a refused add says why and keeps the typed name', async () => {
    const api = stub();
    vi.spyOn(api, 'upsertPlace').mockRejectedValueOnce(new Error('upsertPlace failed (503)'));
    const user = userEvent.setup();
    renderWithProviders(<PlacesSection />, { api });
    const field = await screen.findByLabelText('New place');
    await user.type(field, 'Hardware');
    await user.click(screen.getByRole('button', { name: 'Add place' }));
    expect(await screen.findByText('upsertPlace failed (503)')).toBeTruthy();
    expect((field as HTMLInputElement).value).toBe('Hardware');
  });

  it('renames on blur and edits the link word, moving its errands with it', async () => {
    const { api, corner } = await twoPlaces();
    const t = await api.createTask({ title: 'milk', place: 'corner' });
    const user = userEvent.setup();
    renderWithProviders(<PlacesSection />, { api });

    const name = await screen.findByLabelText('Rename Corner Shop');
    await user.clear(name);
    await user.type(name, 'Corner Store');
    await user.tab();
    await waitFor(async () =>
      expect((await api.listPlaces()).find((p) => p.id === corner.id)?.name).toBe('Corner Store'),
    );

    const slug = await screen.findByLabelText('Link word for Corner Store');
    await user.clear(slug);
    await user.type(slug, 'CS'); // typed capitals land lowercase
    await user.tab();
    await waitFor(async () => expect((await api.getTask(t.id))!.place).toBe('cs'));
  });

  it('a refused link word says why and keeps what was typed', async () => {
    const { api } = await twoPlaces();
    const user = userEvent.setup();
    renderWithProviders(<PlacesSection />, { api });
    const slug = await screen.findByLabelText('Link word for Corner Shop');
    await user.clear(slug);
    await user.type(slug, 'market');
    await user.tab();
    expect(await screen.findByText('Another place already uses "market"')).toBeTruthy();
    expect((slug as HTMLInputElement).value).toBe('market');
  });

  it('a rename and a link-word edit back to back both land — neither blur sends a stale copy', async () => {
    const { api, corner } = await twoPlaces();
    // The first save is still on its way when the second field blurs.
    const real = api.upsertPlace.bind(api);
    vi.spyOn(api, 'upsertPlace').mockImplementation(
      (input) => new Promise((r) => setTimeout(() => r(real(input)), 30)),
    );
    const user = userEvent.setup();
    renderWithProviders(<PlacesSection />, { api });
    const name = await screen.findByLabelText('Rename Corner Shop');
    await user.clear(name);
    await user.type(name, 'Corner Store');
    const slug = screen.getByLabelText('Link word for Corner Shop');
    await user.click(slug); // blurs the name: its save goes out
    await user.clear(slug);
    await user.type(slug, 'cs');
    await user.tab();
    await waitFor(async () =>
      expect((await api.listPlaces()).find((p) => p.id === corner.id)).toMatchObject({
        name: 'Corner Store',
        slug: 'cs',
      }),
    );
  });

  it('the row’s saves run in order — a slow rename can’t land after the link-word edit and undo it', async () => {
    const { api, corner } = await twoPlaces();
    const real = api.upsertPlace.bind(api);
    const log: string[] = [];
    let calls = 0;
    // The first save (the rename) is slow, the second (the link word) quick: unordered, the rename's copy
    // of the old link word would land last.
    vi.spyOn(api, 'upsertPlace').mockImplementation(async (input) => {
      const n = ++calls;
      log.push(`start ${n}`);
      await new Promise((r) => setTimeout(r, n === 1 ? 60 : 0));
      const out = await real(input);
      log.push(`end ${n}`);
      return out;
    });
    const user = userEvent.setup();
    renderWithProviders(<PlacesSection />, { api });
    const name = await screen.findByLabelText('Rename Corner Shop');
    await user.clear(name);
    await user.type(name, 'Corner Store');
    const slug = screen.getByLabelText('Link word for Corner Shop');
    await user.click(slug); // the rename goes out with the old link word
    await user.clear(slug);
    await user.type(slug, 'cs');
    await user.tab();
    await waitFor(() => expect(log).toEqual(['start 1', 'end 1', 'start 2', 'end 2']));
    expect((await api.listPlaces()).find((p) => p.id === corner.id)).toMatchObject({
      name: 'Corner Store',
      slug: 'cs',
    });
  });

  it('a row error clears once the field is put back, and sits on its own line', async () => {
    const { api } = await twoPlaces();
    const user = userEvent.setup();
    renderWithProviders(<PlacesSection />, { api });
    const slug = await screen.findByLabelText('Link word for Corner Shop');
    await user.clear(slug);
    await user.type(slug, 'market');
    await user.tab();
    const error = await screen.findByText('Another place already uses "market"');
    expect(error.tagName).toBe('P'); // a block, under the status line — not run on after it
    await user.clear(slug);
    await user.type(slug, 'corner');
    await user.tab();
    await waitFor(() => expect(screen.queryByText(/already uses/)).toBeNull());
  });

  it('an emptied name says it needs one instead of quietly not saving', async () => {
    const { api } = await twoPlaces();
    const user = userEvent.setup();
    renderWithProviders(<PlacesSection />, { api });
    const name = await screen.findByLabelText('Rename Market');
    await user.clear(name);
    await user.tab();
    expect(await screen.findByText('A place needs a name')).toBeTruthy();
  });

  it('shows open errands and when the Shortcut last called', async () => {
    const { api } = await twoPlaces();
    await api.createTask({ title: 'milk', place: 'corner' });
    renderWithProviders(<PlacesSection />, { api });
    await screen.findByText('1 open errand · Shortcut never called');
  });

  it('counts errands as the Shortcut does — a parent with open parts gives way to them', async () => {
    const { api } = await twoPlaces();
    const party = await api.createTask({ title: 'party', place: 'corner' });
    await api.createTasks([
      { title: 'cups', parentId: party.id },
      { title: 'ice', parentId: party.id },
    ]);
    const user = userEvent.setup();
    renderWithProviders(<PlacesSection />, { api });
    await screen.findByText('2 open errands · Shortcut never called');
    expect((await api.listPlaceTasks('corner')).count).toBe(2);
    await user.click(screen.getByRole('button', { name: 'Delete Corner Shop' }));
    expect(screen.getByLabelText('Move its 2 errands to')).toBeTruthy();
  });

  it('Test shows what the notification would say, and says so when the list is empty', async () => {
    const { api } = await twoPlaces();
    await api.createTask({ title: 'milk', place: 'corner' });
    const user = userEvent.setup();
    renderWithProviders(<PlacesSection />, { api });
    await user.click(await screen.findByRole('button', { name: 'Test Corner Shop' }));
    expect(await screen.findByText('Corner Shop · 1 — milk')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Test Market' }));
    expect(await screen.findByText(/Nothing on the list — the Shortcut stays quiet/)).toBeTruthy();
  });

  it('a failed Test read says so with Retry, not an empty list', async () => {
    const { api } = await twoPlaces();
    api.listPlaceTasks = () => Promise.reject(new Error('listPlaceTasks failed (503)'));
    const user = userEvent.setup();
    renderWithProviders(<PlacesSection />, { api });
    await user.click(await screen.findByRole('button', { name: 'Test Market' }));
    expect(await screen.findByText('Couldn’t read this list.')).toBeTruthy();
    expect(screen.queryByText(/Nothing on the list/)).toBeNull();
  });
});

describe('Settings › Places: delete asks where the errands go', () => {
  it('moves them to the chosen place', async () => {
    const { api, corner } = await twoPlaces();
    const t = await api.createTask({ title: 'milk', place: 'corner' });
    const user = userEvent.setup();
    renderWithProviders(<PlacesSection />, { api });
    await user.click(await screen.findByRole('button', { name: 'Delete Corner Shop' }));
    const panel = within(row('Corner Shop'));
    await user.selectOptions(panel.getByLabelText('Move its 1 errand to'), 'market');
    await user.click(panel.getByRole('button', { name: 'Delete' }));
    await waitFor(async () => expect((await api.getTask(t.id))!.place).toBe('market'));
    expect((await api.listPlaces()).some((p) => p.id === corner.id)).toBe(false);
  });

  it('or off any list with "No place"', async () => {
    const { api } = await twoPlaces();
    const t = await api.createTask({ title: 'milk', place: 'corner' });
    const user = userEvent.setup();
    renderWithProviders(<PlacesSection />, { api });
    await user.click(await screen.findByRole('button', { name: 'Delete Corner Shop' }));
    const select = within(row('Corner Shop')).getByLabelText<HTMLSelectElement>(
      'Move its 1 errand to',
    );
    expect(select.value).toBe(''); // "No place"
    expect([...select.options].map((o) => o.text)).toEqual(['No place', 'Market']);
    await user.click(within(row('Corner Shop')).getByRole('button', { name: 'Delete' }));
    await waitFor(async () => expect((await api.getTask(t.id))!.place).toBeNull());
  });

  it('an empty list just confirms', async () => {
    const { api, market } = await twoPlaces();
    const user = userEvent.setup();
    renderWithProviders(<PlacesSection />, { api });
    await user.click(await screen.findByRole('button', { name: 'Delete Market' }));
    expect(screen.getByText('Delete Market? Nothing is on its list.')).toBeTruthy();
    await user.click(within(row('Market')).getByRole('button', { name: 'Delete' }));
    await waitFor(async () =>
      expect((await api.listPlaces()).some((p) => p.id === market.id)).toBe(false),
    );
  });

  it('a failed delete says so and keeps the panel', async () => {
    const { api } = await twoPlaces();
    vi.spyOn(api, 'deletePlace').mockRejectedValueOnce(new Error('deletePlace failed (503)'));
    const user = userEvent.setup();
    renderWithProviders(<PlacesSection />, { api });
    await user.click(await screen.findByRole('button', { name: 'Delete Market' }));
    await user.click(within(row('Market')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Couldn’t delete — try again.')).toBeTruthy();
    expect(within(row('Market')).getByRole('button', { name: 'Delete' })).toBeTruthy();
  });
});

describe('Settings › Places: the Shortcut token', () => {
  it('generates one, shows it once with Copy, and keeps only the hint after', async () => {
    const api = stub();
    const user = userEvent.setup(); // installs its own clipboard — stub ours after it
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderWithProviders(<PlacesSection />, { api });
    await screen.findByText(/No token yet/);
    await user.click(screen.getByRole('button', { name: 'Generate token' }));
    const field = await screen.findByLabelText<HTMLInputElement>('Shortcut token');
    expect(field.value.startsWith(PLACE_TOKEN_PREFIX)).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith(field.value);
    expect(await screen.findByText('Copied')).toBeTruthy();
    const hint = field.value.slice(-4);
    expect(screen.getByText(new RegExp(`Active · ends …${hint}`))).toBeTruthy();
    expect(screen.getByText(/never used · 0 reads today/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByLabelText('Shortcut token')).toBeNull(); // gone for good
  });

  it('a refused clipboard says to copy by hand', async () => {
    const api = stub();
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('denied')) },
      configurable: true,
    });
    renderWithProviders(<PlacesSection />, { api });
    await user.click(await screen.findByRole('button', { name: 'Generate token' }));
    await screen.findByLabelText('Shortcut token');
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText(/Couldn’t copy — select the token above/)).toBeTruthy();
  });

  it('rotate asks first and mints a different token; revoke asks first and turns it off', async () => {
    const api = stub();
    const first = await api.rotatePlaceToken();
    const user = userEvent.setup();
    renderWithProviders(<PlacesSection />, { api });
    await user.click(await screen.findByRole('button', { name: 'Rotate…' }));
    expect(screen.getByText(/stops working until you paste the new token/)).toBeTruthy();
    // The confirm's own buttons are the choice: the triggers step aside while it's open.
    expect(screen.queryByRole('button', { name: 'Rotate…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke…' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Rotate' }));
    const field = await screen.findByLabelText<HTMLInputElement>('Shortcut token');
    expect(field.value).not.toBe(first.token);

    await user.click(screen.getByRole('button', { name: 'Revoke…' }));
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await screen.findByText(/No token yet/);
    expect((await api.getPlaceTokenStatus()).active).toBe(false);
    expect(screen.queryByLabelText('Shortcut token')).toBeNull();
  });

  it('a revoke that lost to another device says so, not a generic failure', async () => {
    const api = stub();
    await api.rotatePlaceToken();
    vi.spyOn(api, 'revokePlaceToken').mockRejectedValueOnce(new Error(PLACE_TOKEN_RACE_ERROR));
    const user = userEvent.setup();
    renderWithProviders(<PlacesSection />, { api });
    await user.click(await screen.findByRole('button', { name: 'Revoke…' }));
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText(PLACE_TOKEN_RACE_ERROR)).toBeTruthy();
  });

  it('a failed rotate says so', async () => {
    const api = stub();
    vi.spyOn(api, 'rotatePlaceToken').mockRejectedValueOnce(new Error('rotate failed (503)'));
    const user = userEvent.setup();
    renderWithProviders(<PlacesSection />, { api });
    await user.click(await screen.findByRole('button', { name: 'Generate token' }));
    expect(await screen.findByText('Couldn’t make a token — try again.')).toBeTruthy();
  });
});

describe('Settings › Places: the setup recipe', () => {
  it('opens to one Shortcut with this origin’s URL and the header, and one automation per store', async () => {
    const { api } = await twoPlaces();
    const user = userEvent.setup(); // installs its own clipboard — stub ours after it
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderWithProviders(<PlacesSection />, { api });
    await user.click(await screen.findByRole('button', { name: 'Set up the iPhone Shortcut' }));
    // The whole template, /tasks included — the Shortcut Input variable goes where the brackets are.
    const url = `${window.location.origin}/api/places/[Shortcut Input]/tasks`;
    const shown = screen.getByLabelText('URL');
    expect(shown.textContent).toBe(url);
    expect(shown.className).toMatch(/\bbreak-all\b/); // wraps whole at phone width, never truncated
    await user.click(screen.getByRole('button', { name: 'Copy URL' }));
    expect(writeText).toHaveBeenCalledWith(url);
    expect(screen.getByLabelText('Header key').textContent).toBe(AUTH_HEADER);
    // Show `text` whenever it has a value — errors carry one too.
    expect(screen.getByText('has any value')).toBeTruthy();
    // Every step keeps its number: no <li> is itself a flex box (that drops the list marker).
    const steps = shown.closest('ol')!.querySelectorAll(':scope > li');
    expect(steps).toHaveLength(6);
    // Otherwise, an answer with no count either (a CloudFront 5xx/throttle has no body) still says so;
    // an empty list (count 0) stays quiet.
    expect(steps[3]!.textContent).toMatch(/^Under Otherwise: Get Dictionary Value count from/);
    expect(steps[3]!.textContent).toContain('does not have any value');
    expect(steps[3]!.textContent).toContain('Show Notification “Aperture didn’t answer”');
    steps.forEach((li) => expect(li.className).not.toMatch(/\bflex\b/));
    expect(screen.getAllByText('Aperture list', { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText('corner')).toBeTruthy();
    expect(screen.getByText('market')).toBeTruthy();
    expect(screen.getByText('Notify When Run')).toBeTruthy();
  });
});
