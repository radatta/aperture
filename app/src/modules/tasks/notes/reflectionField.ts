import { TASK_REFLECTION_MAX } from '@aperture/shared';

// The reflection is NotesField with its own label, cap and copy (the Done form and the details form).
export const REFLECTION_FIELD = {
  label: 'Reflection',
  max: TASK_REFLECTION_MAX,
  counterFrom: 900,
  rows: 2,
  emptyLabel: 'Add a reflection…',
  plural: false,
};
