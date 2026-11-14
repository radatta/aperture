import { placeTasks } from '@aperture/shared';
import type { Place, PlaceDigest, Task } from '@aperture/shared';
import { RpcParamError } from './types';
import type { Tool } from './types';

// Places — errand lists by store (docs/areas/tasks/places.md). Two reads; a task joins a list through
// `place` on create_task / create_tasks / update_task. Voice: "add batteries to my Grocer list" →
// list_places → create_task { place }. Neither read is the Shortcut's: no heartbeat, no count.

// A place slug as the model may say it ('Grocer', '@grocer') → the stored form. null clears.
export function placeArg(args: Record<string, unknown>, key: string): string | null {
  const v = args[key];
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new RpcParamError(`"${key}" must be a place slug or null`);
  return v.trim().replace(/^@/, '').toLowerCase() || null;
}
export const PLACE_ARG_DESC =
  'the errand list: a place slug from list_places (e.g. "grocer"), or null for none. An errand is checked off at the store, never a calibration point';

export const PLACE_TOOLS: Tool[] = [
  {
    name: 'list_places',
    description:
      "List the user's places — errand lists by store (id, name, slug, lastReadAt), in the order added. The slug is what create_task / update_task take as `place`, and what the user types as @slug. lastReadAt is the iPhone Shortcut's last read of that list (it fires on arriving at the store). Places are added in the app (Settings › Places).",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (_args, ctx) => (await ctx.dispatch('listPlaces', [])) as Place[],
  },
  {
    name: 'list_place_tasks',
    description:
      "One place's open errands, oldest first: { place, slug, count, titles, text, tasks: [{ id, title, status }] } — `text` is exactly what the iPhone notification shows on arrival. A pure read (it doesn't count as the Shortcut's read). Use the ids with complete_task (an errand needs no actualMin) or update_task.",
    inputSchema: {
      type: 'object',
      properties: { place: { type: 'string', description: 'place slug from list_places' } },
      required: ['place'],
      additionalProperties: false,
    },
    async run(args, ctx) {
      const slug = placeArg(args, 'place');
      if (!slug) throw new RpcParamError('"place" is required');
      const digest = (await ctx.dispatch('listPlaceTasks', [slug])) as PlaceDigest;
      const tasks = placeTasks(slug, (await ctx.dispatch('listTasks', [])) as Task[]);
      return { ...digest, tasks: tasks.map(({ id, title, status }) => ({ id, title, status })) };
    },
  },
];
