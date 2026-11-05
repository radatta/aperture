// The four Flux pages behind one dynamic import (routes.tsx): the ritual's main chunk stops carrying them,
// and a Flux visit fetches one `flux-pages-*.js`. The night line (Home/FluxGlance) and Settings' voice
// picker import modules/flux directly and stay in main (docs/areas/flux D64).
export { FluxPage } from './index';
export { FluxExerciseView } from './ExerciseView';
export { FluxLibraryTab } from './LibraryTab';
export { FluxHistoryTab } from './HistoryTab';
