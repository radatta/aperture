import { PULSE_NOTE_MAX } from '@aperture/shared';
import type { PulseInput, PulseResult } from '@aperture/shared';
import { RpcParamError } from './types';
import type { Tool } from './types';

// Pulse tracking (docs/areas/mcp/pulse.md): a Claude session names the task each reply was for, and the server
// times it — sessions, gaps, the actual. The client sends no time and decides nothing. The paste-in project
// instructions that drive it: docs/areas/mcp/pulse-instructions.md.

const KEYS = new Set(['taskId', 'note', 'done']);

export function pulseArgs(args: Record<string, unknown>): PulseInput {
  const extra = Object.keys(args).filter((k) => !KEYS.has(k));
  if (extra.length) throw new RpcParamError(`Unknown argument: ${extra.join(', ')}`);
  const { taskId, note, done } = args;
  if (typeof taskId !== 'string' || !taskId.trim())
    throw new RpcParamError('"taskId" is required: the task this reply was for');
  if (note !== undefined && note !== null && typeof note !== 'string')
    throw new RpcParamError('"note" must be a string');
  if (done !== undefined && typeof done !== 'boolean')
    throw new RpcParamError('"done" must be true or false');
  return {
    taskId: taskId.trim(),
    ...(typeof note === 'string' ? { note } : {}),
    ...(done === true ? { done } : {}),
  };
}

export const PULSE_TOOLS: Tool[] = [
  {
    name: 'pulse',
    description:
      "Record that the reply you are writing was work on this task. Aperture times it from the pulses themselves: the first pulse on a task opens a work session (and starts an unstarted task), pulses close together extend it, a long gap ends it, a pulse for another task ends the current one, and the task's actual minutes are the sum of its sessions. Send no times and never compute minutes yourself. Called on every reply under project instructions that ask for pulses — those instructions are the user's standing approval; anywhere else, ask before the first one. done: true finishes the task when the work is known to be finished; if it can't be finished yet the answer says why in `needs` (estimate: ask what they would have estimated, set it with update_task, pulse done again; actual: ask how long it took and use complete_task with their number; app: a timer or a LeetCode sitting times it — finish it in Aperture). counted: false (reason timer or sitting) is normal: something else times that task. Answer: { task, counted, reason?, opened, sessionMin, taskActualMin, pulses, closed?, done?, needs?, message? }.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'the task this reply was for (from list_tasks or create_task)',
        },
        note: {
          type: 'string',
          description: `optional: a few plain words on what this reply covered, one line (cut at ${PULSE_NOTE_MAX} characters); no code, quotes or personal details`,
        },
        done: {
          type: 'boolean',
          description:
            'true when the work is finished and known to be (they said so, it was submitted or sent)',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
    run: async (args, ctx) => (await ctx.dispatch('pulseTask', [pulseArgs(args)])) as PulseResult,
  },
];
