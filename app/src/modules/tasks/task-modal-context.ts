import { createContext, useContext } from 'react';
import type { Task } from '@aperture/shared';
import type { TaskEditorIntent } from './editor/TaskEditor';

// Opens the task modal the page hosts (TaskModalHost). `trigger` is the row's title button — where
// focus returns on close, while that row still exists. Opened from inside the modal, the trigger is in
// the dialog itself, so the row that first opened it keeps that role (TaskModalHost).
export type OpenTask = (
  task: Task,
  intent: TaskEditorIntent,
  trigger: HTMLButtonElement | null,
) => void;

export const TaskModalContext = createContext<OpenTask | null>(null);

export const useOpenTask = () => useContext(TaskModalContext);
