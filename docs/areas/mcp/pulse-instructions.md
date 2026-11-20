# Pulse instructions — the block a claude.ai project pastes in

The standing instructions that make a claude.ai project pulse its work into Aperture ([pulse.md](pulse.md)). The
first test is the recruiting project; the block is project-agnostic, so a later project pastes the same one. It goes
after the project's own standing rules.

Copy it on the Mac (one line; the markers keep this header out):

```
cd <mac-repo> && git fetch origin && git show origin/main:docs/areas/mcp/pulse-instructions.md | awk '/paste:start/{f=1;next}/paste:end/{f=0}f' | pbcopy
```

Keep the block short: standing instructions decay over a long thread, and the pulse is the one that must survive.
The windows, the grace and every other number stay server-side ([pulse.md](pulse.md) → _Numbers_), so retuning them
never means re-pasting this.

<!-- paste:start -->

## Time tracking (Aperture pulse)

Aperture times this work from your `pulse` calls. You have no clock; the server does. Your only job is to say which task each reply was for.

- **Thread start: link one task.** Before your first reply, call `list_tasks` for in_progress, then planned (backlog only if nothing fits). One clear match: use it and say "Tracking: <title>". Nothing fits: ask in one line, "Track this as '<title>', about N min?", and call `create_task` (title, estimateMin, a fitting category) only on a yes. Two could fit, or you are unsure: ask which, in one line. Never guess, and never make a second task for work that already has one. "Don't track this" ends tracking for the thread.
- **Every reply: pulse first.** Once a task is linked, begin every reply with `pulse` (the task id; note: a few plain words on what the reply covered, with no code, quotes or personal details). Don't ask before a pulse and don't mention it. If a call fails, carry on and pulse on the next reply. Never retry in a loop or make up for a missed one.
- **A switch.** When the work moves to something else, pulse that task instead, linked or created as above. Unsure whether it is a new task: ask in one line.
- **Done.** When the work is finished and you know it (they said so, it was submitted or sent), send the last pulse with done: true. Unsure: ask "Mark '<title>' done?". If the answer has needs: "estimate", ask what they would have estimated, set it with `update_task`, and pulse done again. Never call `complete_task` with minutes you worked out yourself.
- **Answers.** counted: false (reason "timer" or "sitting") is normal: something else is timing that task, so keep going. "Task is already done" or "Not found": stop pulsing it and ask which task this is.
- **LeetCode.** During a sitting, don't pulse: the sitting times the problem, and it is finished with Done in Aperture. Pulse everything else: learning a topic, behavioral practice, system design, a mock outside a sitting, company prep, a debrief.
- Never state how long something took unless a tool answer gave the number.

<!-- paste:end -->
