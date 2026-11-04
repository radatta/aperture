// Places — errand lists by store ("arrive at Safeway → what do I need there?"). Pure rules shared by the
// stub and the Lambda: slug shape, the digest the iPhone Shortcut shows, and the token's constants. A task
// joins a list by carrying the place's slug (Task.place); a placed task is an errand, never a calibration
// point (machines.ts contributesCalibration). Aperture never sees a location — the geofence is the iPhone's
// Shortcuts automation, which calls GET /api/places/<slug>/tasks with a place token. Design record:
// docs/areas/tasks/places.md.

import type { Place, Task } from './types';

// The slug is the word in `@slug`, the Shortcut's URL segment and the lens link — lowercase so the URL
// route and the grammar agree without case folding.
export const PLACE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const PLACE_NAME_MAX = 40;
// Hidden guard on the Shortcut route: reads per token per (UTC) day. Past it the route answers 429 and
// writes nothing — what keeps a leaked token's worst case to cents of DynamoDB (places.md → Cost).
export const PLACE_READ_DAILY_CAP = 200;
export const PLACE_TOKEN_PREFIX = 'apl_';
// The digest text lists at most this many titles; `titles` always carries them all.
export const PLACE_DIGEST_TITLES_MAX = 12;

export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '');

export const placeUnknownError = (slug: string): string =>
  `No place "${slug}" — add it in Settings › Places`;
// A finished (done/cancelled) task's place is history, like its estimate: moving it on or off a list
// would flip whether it counts in calibration after the fact (contributesCalibration).
export const PLACE_FINISHED_ERROR = "A finished task's place is history — it can't move lists";
// Rotate/revoke lost the race to the same call on another device (the pointer changed since it was read).
export const PLACE_TOKEN_RACE_ERROR = 'The Shortcut token changed on another device — try again';

// What the Shortcut route's body carries as `text` on a failure — every answer has a `text`, so the
// recipe's one rule is "show `text` if it isn't empty" and no failure is silent. CloudFront turns an origin
// 403/404 into the app's index.html (200), so the route never answers 404: an unknown place is a 422.
export const PLACE_READ_TEXT = {
  unauthorized: "Aperture: the Shortcut's token isn't valid — make a new one in Settings › Places",
  method: "Aperture: the Shortcut's Get Contents of URL must use GET",
  path: "Aperture: the Shortcut's URL isn't a place list — check its input or Settings › Places",
  cap: 'Aperture: the Shortcut hit its daily limit — try tomorrow',
  error: "Aperture couldn't read the list — try again",
} as const;
export const placeReadUnknownText = (slug: string): string =>
  `Aperture: no place "${slug}" — check the Shortcut's input or Settings › Places`;

// Why a place can't be saved as given, or null. `others` = the user's other alive places.
export function placeError(
  name: string,
  slug: string,
  others: readonly Pick<Place, 'slug'>[],
): string | null {
  if (!name.trim()) return 'A place needs a name';
  if (name.trim().length > PLACE_NAME_MAX)
    return `A place name is at most ${PLACE_NAME_MAX} characters`;
  if (!PLACE_SLUG_RE.test(slug))
    return 'A place link is lowercase letters, digits and dashes (up to 32), starting with a letter or digit';
  if (others.some((p) => p.slug === slug)) return `Another place already uses "${slug}"`;
  return null;
}

// The Shortcut's payload — and the Settings "Test" preview, so both show the same words.
export interface PlaceDigest {
  place: string; // display name
  slug: string;
  count: number;
  titles: string[]; // every open errand, oldest first
  text: string; // ready for Show Notification; '' when count is 0 (the Shortcut skips the banner)
}
// What the Shortcut route returns: the digest plus the tap-through link to the Places lens.
export interface PlaceRead extends PlaceDigest {
  url: string;
}
// Any non-200 answer: `error` for logs/tools, `text` (PLACE_READ_TEXT) for the notification.
export interface PlaceReadError {
  error: string;
  text: string;
}

export function placeDigestText(name: string, titles: readonly string[]): string {
  if (titles.length === 0) return '';
  const shown = titles.slice(0, PLACE_DIGEST_TITLES_MAX).join(', ');
  const more = titles.length - PLACE_DIGEST_TITLES_MAX;
  return `${name} · ${titles.length} — ${shown}${more > 0 ? ` +${more} more` : ''}`;
}

const OPEN = new Set<Task['status']>(['backlog', 'planned', 'in_progress']);

// The open errands on one list: alive, not done/cancelled, oldest first.
export const placeTasks = (slug: string, tasks: readonly Task[]): Task[] =>
  tasks
    .filter((t) => t.place === slug && t.deletedAt === null && OPEN.has(t.status))
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));

export function placeDigestOf(
  place: Pick<Place, 'name' | 'slug'>,
  tasks: readonly Task[],
): PlaceDigest {
  const titles = placeTasks(place.slug, tasks).map((t) => t.title);
  return {
    place: place.name,
    slug: place.slug,
    count: titles.length,
    titles,
    text: placeDigestText(place.name, titles),
  };
}

// The lens link a tap on the notification (or the Shortcut's Open URL) lands on.
export const placeLensPath = (slug: string): string =>
  `/tasks?lens=places&place=${encodeURIComponent(slug)}`;

// Create (no id): slug defaults to slugify(name). Update (id set): name replaces; an omitted slug keeps
// the current one, a changed slug rewrites the place's tasks.
export interface UpsertPlaceInput {
  id?: string;
  name: string;
  slug?: string;
}

// The Shortcut token's health, for Settings. Never the token or its hash — `hint` is its last 4.
export interface PlaceTokenStatus {
  active: boolean;
  createdAt: number | null;
  lastUsedAt: number | null;
  hint: string | null;
  readsToday: number;
}
