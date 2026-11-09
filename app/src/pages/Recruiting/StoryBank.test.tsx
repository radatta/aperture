import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/utils';
import { createStubClient } from '../../data/stubClient';

beforeEach(() => globalThis.localStorage?.clear());
afterEach(() => vi.restoreAllMocks());

function freshApi() {
  return createStubClient({ seed: false, storageKey: `stories-${Math.random()}` });
}

describe('story bank', () => {
  it('creates a story with multiple tags, empty S/A/R allowed, and shows it in the list', async () => {
    const api = freshApi();
    const user = userEvent.setup();
    renderApp({ api, path: '/recruiting/stories' });

    // Collapsed until asked, then the title takes focus.
    expect(screen.queryByLabelText('Title')).toBeNull();
    await user.click(await screen.findByRole('button', { name: /New story/ }));
    expect(document.activeElement).toBe(screen.getByLabelText('Title'));

    await user.type(screen.getByLabelText('Title'), 'Led the migration');
    await user.click(screen.getByRole('button', { name: 'ownership' }));
    await user.click(screen.getByRole('button', { name: 'leadership' }));
    // Only Situation filled — Action/Result deliberately left empty (title-only-plus stub is valid).
    await user.type(screen.getByLabelText('Situation'), 'Prod was down.');
    await user.click(screen.getByRole('button', { name: 'Add story' }));

    expect(await screen.findByText('Led the migration')).toBeTruthy();
    await waitFor(async () => {
      const [s] = await api.listStories();
      expect(s?.competencyTags).toEqual(['ownership', 'leadership']);
      expect(s?.situation).toBe('Prod was down.');
      expect(s?.action).toBe('');
      expect(s?.result).toBe('');
    });
  });

  it('requires a title — Add story stays disabled while it is blank', async () => {
    const user = userEvent.setup();
    renderApp({ api: freshApi(), path: '/recruiting/stories' });

    await user.click(await screen.findByRole('button', { name: /New story/ }));
    const addBtn = () => screen.getByRole('button', { name: 'Add story' }) as HTMLButtonElement;
    expect(addBtn().disabled).toBe(true);
    await user.type(screen.getByLabelText('Title'), 'Has a title now');
    expect(addBtn().disabled).toBe(false);
  });

  // The trigger unmounts while the form is open, so closing remounts it — without an explicit handoff a
  // keyboard user lands at the top of the document. Cancel must also drop the draft.
  it('returns focus to the trigger on cancel and drops the draft', async () => {
    const user = userEvent.setup();
    renderApp({ api: freshApi(), path: '/recruiting/stories' });

    await user.click(await screen.findByRole('button', { name: /New story/ }));
    await user.type(screen.getByLabelText('Title'), 'half a thought');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    const trigger = screen.getByRole('button', { name: /New story/ });
    expect(document.activeElement).toBe(trigger);
    await user.click(trigger);
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('');
  });

  it('edits a story in place and persists the change', async () => {
    const api = freshApi();
    await api.createStory({ title: 'Handled the outage', result: '' });
    const user = userEvent.setup();
    renderApp({ api, path: '/recruiting/stories' });

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const result = screen.getByLabelText('Result');
    await user.type(result, 'Cut MTTR in half.');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () =>
      expect((await api.listStories())[0]?.result).toBe('Cut MTTR in half.'),
    );
  });

  it('asks before deleting, then removes the story', async () => {
    const api = freshApi();
    await api.createStory({ title: 'To be deleted' });
    const user = userEvent.setup();
    renderApp({ api, path: '/recruiting/stories' });

    await user.click(await screen.findByLabelText('More actions for To be deleted'));
    await user.click(screen.getByRole('menuitem', { name: /Delete/ }));
    // The menu item only opens the confirm — nothing deleted yet.
    expect(await api.listStories()).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(async () => expect(await api.listStories()).toHaveLength(0));
  });

  // Mirrors the Attempts tab: a failed or in-flight query must not render the "No stories yet" empty
  // state, which would tell you to add your first story on top of a load you can't see.
  it('shows error and loading states, not the empty state', async () => {
    const reject = freshApi();
    vi.spyOn(reject, 'listStories').mockRejectedValue(new Error('boom'));
    const { unmount } = renderApp({ api: reject, path: '/recruiting/stories' });
    expect(await screen.findByText(/Couldn't load this/)).toBeTruthy();
    expect(screen.queryByText(/No stories yet/)).toBeNull();
    unmount();

    const hang = freshApi();
    vi.spyOn(hang, 'listStories').mockImplementation(() => new Promise(() => {}));
    renderApp({ api: hang, path: '/recruiting/stories' });
    expect(await within(screen.getByRole('main')).findByText('Loading…')).toBeTruthy();
    expect(screen.queryByText(/No stories yet/)).toBeNull();
  });
});
