import { useLayoutEffect } from 'react';

// Where the editor's edits stand, for the task modal's exit paths.
export type EditState = 'clean' | 'dirty' | 'saving';

// One slot per form (the details fields; the open reveal — Add parts / Split), kept current from a
// layout effect: in the commit, so an exit on the very next event reads the last render's truth.
// Reported through effects it reached the modal two hops (a frame) late, and an Esc in that window
// closed without asking. `changed` re-renders the modal, so a held exit runs when its save lands.
export interface EditSlots {
  details: EditState;
  reveal: EditState;
  changed: () => void;
}

const rank: Record<EditState, number> = { clean: 0, dirty: 1, saving: 2 };
// A write in flight anywhere holds an exit; else anything unsaved asks.
export const editState = (s: EditSlots): EditState =>
  rank[s.details] >= rank[s.reveal] ? s.details : s.reveal;

export function useEditSlot(
  slots: EditSlots | undefined,
  slot: 'details' | 'reveal',
  state: EditState,
) {
  useLayoutEffect(() => {
    if (!slots) return;
    slots[slot] = state;
    slots.changed();
    // The form's gone (a cancelled reveal, a closed modal): nothing of it stands in the way.
    return () => {
      slots[slot] = 'clean';
      slots.changed();
    };
  }, [slots, slot, state]);
}
