// Query keys, one per access pattern — mirrors the ApiClient/stub read methods.
export const qk = {
  settings: () => ['settings'] as const,
  log: (day: string) => ['log', day] as const,
  tasks: () => ['tasks'] as const,
  plans: (day: string) => ['plans', day] as const,
  categories: () => ['categories'] as const,
  // Every place key starts with 'places', so a place edit refreshes the Settings "Test" previews too.
  places: () => ['places'] as const,
  placeDigest: (slug: string) => ['places', 'digest', slug] as const,
  placeToken: () => ['placeToken'] as const,
  series: () => ['series'] as const,
  calibration: (from: string, to: string) => ['calibration', from, to] as const,
  leetcodeAttempts: (from = 'all', to = 'all') => ['leetcodeAttempts', from, to] as const,
  stories: () => ['stories'] as const,
  // Flux sets: one prefix, so a save or delete refreshes every History / night-line read.
  fluxSetsAll: () => ['fluxSets'] as const,
  fluxWeekNote: () => ['fluxSets', 'weekNote'] as const, // under fluxSets: a saved or deleted set refreshes it
  fluxSets: (from = 'all', to = 'all', exerciseId = 'all') =>
    ['fluxSets', from, to, exerciseId] as const,
  attachments: () => ['attachments'] as const,
  attachmentUrl: (id: string) => ['attachmentUrl', id] as const,
  habits: () => ['habits'] as const,
  runningSessions: () => ['runningSessions'] as const,
  habitChecks: (from: string, to: string) => ['habitChecks', from, to] as const,
  rolls: () => ['rolls'] as const,
  ideas: (status = 'all') => ['ideas', status] as const,
  day: (day: string) => ['day', day] as const,
  googleStatus: () => ['googleStatus'] as const,
  googleCalendars: () => ['googleCalendars'] as const,
  calendarBusy: (day: string) => ['calendarBusy', day] as const,
  // Every finance key starts with 'finance', so one invalidation refreshes the whole page.
  finance: () => ['finance'] as const,
  financeOverview: (today: string) => ['finance', 'overview', today] as const,
  financeTxns: (from: string, to: string) => ['finance', 'txns', from, to] as const,
  financeRules: () => ['finance', 'rules'] as const,
};
