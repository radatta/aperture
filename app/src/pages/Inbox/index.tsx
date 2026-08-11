import { todayKey } from '@aperture/shared';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { EmptyState } from '../../components/EmptyState';
import { Text } from '../../components/Text';
import { useCreateLogEntry } from '../../data/hooks/useLog';
import { useCreateTask } from '../../data/hooks/useTasks';
import { useIdeas, useTriageIdea } from '../../data/hooks/useIdeas';
import { useSettings } from '../../data/hooks/useSettings';

// Quick-capture inbox (PRODUCT §2, §4b): Idea-mode captures land here. Triage each into a task or a
// log entry, or discard. ("Note" folds into the log — v1 has no separate note entity; the log IS the
// note substrate.) Nothing is destructive — triage soft-sets status; the idea is never hard-deleted.
export function InboxPage() {
  const { data: settings } = useSettings();
  const today = todayKey(settings?.dayStartHour ?? 4);
  const { data: ideas = [], isPending, isError } = useIdeas('open');

  const createTask = useCreateTask();
  const createLog = useCreateLogEntry(today);
  const triage = useTriageIdea();

  return (
    <div className="flex flex-col gap-5">
      <Text as="h1" size="2xl" weight="semibold">
        Inbox
      </Text>
      {ideas.length === 0 ? (
        <EmptyState pending={isPending} error={isError} title="Inbox is clear.">
          Switch the bar below to Idea and anything half-formed lands here, to be sorted whenever
          you feel like it.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-2">
          {ideas.map((idea) => (
            <Card key={idea.id} className="px-3.5 py-3">
              <div className="flex items-start justify-between gap-3">
                <Text className="min-w-0 flex-1">{idea.text}</Text>
                <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                  <Button
                    size="sm"
                    onClick={async () => {
                      await createTask.mutateAsync(idea.text);
                      triage.mutate({ id: idea.id, status: 'triaged' });
                    }}
                  >
                    Make task
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      await createLog.mutateAsync(idea.text);
                      triage.mutate({ id: idea.id, status: 'triaged' });
                    }}
                  >
                    To log
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => triage.mutate({ id: idea.id, status: 'discarded' })}
                  >
                    Discard
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
