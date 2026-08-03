// Tiny classname joiner — rolled our own instead of pulling in clsx (an ~8-line util is below
// the dependency threshold). Handles the string + conditional cases we actually use.
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}
