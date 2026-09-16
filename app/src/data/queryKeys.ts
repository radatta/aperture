// Query keys, one per access pattern — mirrors the ApiClient/stub read methods.
export const qk = {
  settings: () => ['settings'] as const,
  log: (day: string) => ['log', day] as const,
  backlog: () => ['backlog'] as const,
  tasks: () => ['tasks'] as const,
  plans: (day: string) => ['plans', day] as const,
  categories: () => ['categories'] as const,
  series: () => ['series'] as const,
  calibration: (from: string, to: string) => ['calibration', from, to] as const,
  leetcodeAttempts: (from = 'all', to = 'all') => ['leetcodeAttempts', from, to] as const,
  stories: () => ['stories'] as const,
  habits: () => ['habits'] as const,
  habitChecks: (from: string, to: string) => ['habitChecks', from, to] as const,
  ideas: (status = 'all') => ['ideas', status] as const,
  day: (day: string) => ['day', day] as const,
};
