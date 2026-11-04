import { useState } from 'react';
import type { Story } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { Menu } from '../../components/Menu';
import { Text } from '../../components/Text';
import { PlusIcon } from '../../components/icons';
import {
  useCreateStory,
  useDeleteStory,
  useStories,
  useUpdateStory,
} from '../../data/hooks/useStories';
import { useDisclosure } from '../../lib/useDisclosure';
import { StoryEditor, type StoryFields } from './StoryEditor';

// The Stories tab — the behavioral story bank. ~8–12 STAR stories, updatedAt-desc, each editable in
// place. The "New story" form is collapsed by default (the tab's job is to show the bank, not greet you
// with a form); opening/closing hands focus back to the trigger via useDisclosure.
export function StoryBank() {
  const { data: stories = [], isPending, isError, refetch } = useStories();
  const create = useCreateStory();
  const { open, triggerRef, onOpen, onClose } = useDisclosure();

  function add(fields: StoryFields) {
    create.mutate(fields, { onSuccess: () => onClose() });
  }

  return (
    <div className="flex flex-col gap-4">
      {open ? (
        <Card>
          <div className="flex flex-col gap-3">
            <Text size="sm" weight="medium">
              New story
            </Text>
            <StoryEditor pending={create.isPending} onSave={add} onCancel={onClose} />
          </div>
        </Card>
      ) : (
        <div>
          <Button ref={triggerRef} variant="ghost" size="sm" onClick={onOpen} className="gap-1.5">
            <PlusIcon size={15} /> New story
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {stories.length === 0 ? (
          <EmptyState pending={isPending} error={isError} onRetry={() => void refetch()} title="No stories yet.">
            Add your first with “New story” — a title now, the STAR details whenever you have them.
          </EmptyState>
        ) : (
          stories.map((s) => <StoryRow key={s.id} story={s} />)
        )}
      </div>
    </div>
  );
}

function StoryRow({ story }: { story: Story }) {
  const update = useUpdateStory();
  const del = useDeleteStory();
  const edit = useDisclosure();
  const [confirming, setConfirming] = useState(false);

  function save(fields: StoryFields) {
    update.mutate({ id: story.id, patch: fields }, { onSuccess: () => edit.onClose() });
  }

  // Editing expands the row into the same editor, seeded with the story. It mounts fresh each time, so
  // its form state always starts from the current story rather than a stale draft.
  if (edit.open) {
    return (
      <Card>
        <div className="flex flex-col gap-3">
          <Text size="sm" weight="medium">
            Edit story
          </Text>
          <StoryEditor
            initial={story}
            pending={update.isPending}
            onSave={save}
            onCancel={edit.onClose}
          />
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Text weight="medium" className="truncate">
            {story.title}
          </Text>
          {story.competencyTags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {story.competencyTags.map((t) => (
                <span
                  key={t}
                  className="rounded-md border border-line px-1.5 py-0.5 text-xs capitalize text-ink-muted"
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button ref={edit.triggerRef} variant="quiet" size="sm" onClick={edit.onOpen}>
            Edit
          </Button>
          <Menu
            label={`More actions for ${story.title}`}
            items={[
              { label: 'Delete…', tone: 'danger', onSelect: () => setConfirming(true) },
            ]}
          />
        </div>
      </div>

      {/* Soft-delete has no UI undo, so it asks first — the same alertdialog strip the habit card uses.
          autoFocus so a keyboard/SR user lands on the destructive question that just appeared below. */}
      {confirming && (
        <div
          role="alertdialog"
          aria-label={`Delete ${story.title}?`}
          className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface p-3"
        >
          <Text size="sm" tone="muted">
            Delete “{story.title}”? It's removed from the bank; this isn't undoable here.
          </Text>
          <Button
            autoFocus
            variant="gold"
            size="sm"
            disabled={del.isPending}
            onClick={() => del.mutate(story.id)}
          >
            Delete
          </Button>
          <Button variant="quiet" size="sm" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      )}
    </Card>
  );
}
