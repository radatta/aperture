// The paths that run the iOS-entry scenarios' slow steps (their slowPaths), apart from the scenarios so the bot — plain
// node, builtins only — can read them too: `pnpm bot deploy-dev` sends a branch touching any of them to slot A,
// whose Simulator is the only one (bot/ios-routing.ts, CI-BOT.md → Dev slots). No imports.

// What these rows can see: the keyboard's lift and the fields it covers, zoom, the shell and its insets, staying signed
// in, the service worker's second launch. `app/**` would rerun the sim on every app change, ~6 min a run for most of them
// nothing iOS can see (the maintainer, 2026-11-05). Elsewhere an iOS-only bug waits for --tier all or naming the scenario.
const APP = [
  'app/index.html',
  'app/vite.config.ts',
  'app/pwa/**',
  'app/src/main.tsx',
  'app/src/index.css',
  'app/src/auth/**',
  'app/src/lib/useKeyboardInset.ts',
  'app/src/components/AppNav.tsx',
  'app/src/components/AppShell.tsx',
  'app/src/components/Modal/**',
  'app/src/modules/capture/CaptureBar.tsx',
  'app/src/modules/capture/mode.ts',
  'app/src/modules/capture/useAutoGrow.ts',
  'app/src/modules/tasks/QueryControls.tsx',
  'app/src/modules/tasks/DoneForm.tsx',
  'app/src/modules/tasks/TaskModal.tsx',
  'app/src/modules/tasks/editor/TaskEditor.tsx',
  'app/src/modules/tasks/notes/NotesField.tsx',
];
const HARNESS = [
  'tools/mailroom/jobs/sim.sh',
  'scripts/src/mailroom/sim.ts',
  'scripts/src/devcheck/ios.ts',
  'scripts/src/devcheck/scenarios/ios-standalone.ts',
  'scripts/src/devcheck/lanes.ts', // the iPhone lane itself: a lane-only change still runs it on slot A
];

export const IOS_STANDALONE_PATHS = [...APP, ...HARNESS];
export const IOS_PROBE_PATHS = [
  'scripts/src/devcheck/probe-only.ts',
  'scripts/src/devcheck/scenarios/ios-probe.ts',
];
// The Review chip on the Simulator (category-suggest-ios), and category-suggest, whose history it seeds.
export const CATEGORY_SUGGEST_IOS_PATHS = [
  'app/src/modules/capture/CaptureBar.tsx',
  'app/src/modules/capture/PreviewCategory.tsx',
  'scripts/src/devcheck/scenarios/category-suggest.ts',
  'scripts/src/devcheck/scenarios/category-suggest-ios.ts',
];
// Every scenario with an ios step; scenarios/index.test.ts pins it to their slowPaths.
export const IOS_SLOW_PATHS = [
  ...IOS_STANDALONE_PATHS,
  ...IOS_PROBE_PATHS,
  ...CATEGORY_SUGGEST_IOS_PATHS,
];
