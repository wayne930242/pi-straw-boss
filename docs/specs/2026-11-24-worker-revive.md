# A subagent that dies under a live launcher comes back (2026-11-24)

Status: implemented on `feat/revive-dead-workers` (base `main` f0184b6f, 0.87.1). How it behaves for a user: [how-it-works, A subagent that dies is revived](../how-it-works.md#a-subagent-that-dies-is-revived).

## Boss words (binding)

> 「這東西也要做，如果有 pi session 當掉了，拿我們 sb 這邊記錄的 pi session 把他拉回來」, scope: 「worker（子 agent）也拉回來」.

A dead main is revived by its tower ([2026-11-23-tower-revive.md](2026-11-23-tower-revive.md)). A subagent whose own pi dies while its launcher lives was not: pi-herdr-agents delivers a failure, and the launcher's model respawns it or gives up. Now Straw Boss revives it from its session file, and its result reaches the launcher as if nothing happened.

## Decisions (within the brief)

| # | Question | Decision |
|---|---|---|
| W1 | Who acts | The launcher's own Straw Boss (the main, member, or train that ran `subagent`), on the 15 s look orphan.ts and restored.ts share. Only that process knows what it launched, what its transcript holds, and can hand its model a message; no tower and no server is involved. |
| W2 | What a death is | A `subagent_result` that pi-herdr-agents wrote for a run whose pi ended without a report of its own (§1). Not a cancel, a completion, a provider error the child reported, a help request, or a persistent specialist. |
| W3 | How it comes back | The run's own launch command (its newest launch or resume script in the launcher's artifacts): the same session file, folder (a managed worktree's checkout too), model, thinking, tools, environment, and pi-herdr-agents' child extension, with one change: the first message is a revive notice instead of the task. In a new pane split from the launcher's own pane, labelled with the run's name. |
| W4 | Which kinds | Every subagent the brief calls a worker (worker, scout, reviewer, …), not only role `worker`. A persistent specialist is not revived: pi-herdr-agents cannot re-adopt one. |
| W5 | The result | pi-herdr-agents no longer tracks the run once it delivered the failure, so Straw Boss watches the revived pi and delivers its `.exit` the way a revived main's inherited runs are delivered (inherit.ts): the last message, encoded, as `straw-boss-orphan-result`. |
| W6 | What the launcher's model sees | The failure itself, with a Straw Boss paragraph added to it before the model reads it (it is a death, Straw Boss revives the run, do not resume or respawn it); one line when the run is back (no turn); the report when it ends (a turn). |
| W7 | Retries | One revive per death. A revive that cannot start, and a revived pi that ends again without a report, are given up with one message to the launcher, which then decides (`subagent_resume` or a new run). |

## 1. What a death looks like

pi-herdr-agents' watcher (maestro `completion.js`, `pi-run-session.js`) ends a run on the child's `.exit` sidecar (done, error, ping), on the launch script's `__SUBAGENT_DONE_<code>__` sentinel, or on the pane's disappearance, and delivers one `subagent_result` whose `details` carry `sessionFile`, `exitCode`, and `errorMessage` when there is one. The child writes `.exit` before it exits, so a report always comes through the sidecar. One table (`src/childdead.ts` `deathOf`) reads the details:

| Details | Means | Death |
|---|---|---|
| `error: "cancelled"` or `cancellation` | the launcher cancelled it | no |
| `error: "persistent-crash"` | a persistent specialist ended | no (not revivable) |
| `exitCode: 0` | it completed (a sidecar `done`, or pi exited cleanly) | no |
| `errorMessage` that is none of the three below | the child reported an error (`.exit` type `error`, a provider error) | no |
| `errorMessage` "Subagent pane disappeared …" | its pane was closed (the boss, an agent's `herdr pane close`, a tab closed): maestro types the script into the pane's own shell, so a pi that crashes or is killed leaves the shell and its sentinel, and only a closed pane gives this text | no |
| `errorMessage` "… native execution ended …", "… process exited before completion evidence was recorded." | its process went away before any report | yes |
| no `errorMessage`, `exitCode` 130 | pi ended on SIGINT: a Ctrl-C in its pane | no |
| no `errorMessage`, any other `exitCode` | pi exited without a report: a crash (1), a kill (137), a signal | yes |

A death also needs a session file that exists and holds at least one message (pi exited before its session started is a launch failure, not a death).

## 2. One table, two looks

`classify` (the same module) decides each death at each look, from facts the look gathers, the way `dead.ts` decides a main:

| State | Evidence |
|---|---|
| `refused` | no launch script names the file, the script's command cannot be read (§3), the run is a persistent specialist, its session never started, a revive of this file failed before or came within the last 10 minutes; or the death is superseded: older than 10 minutes when this launcher first looked at it (a transcript from before this version), a later `subagent_result` or `subagent_ping` names the file, or a launch or resume script generated after the death names it |
| `live` | a pane of Herdr runs the file, the broker lists its session id (the header's), pi-herdr-agents tracks the run's id, or the file moved in the last 60 s: someone resumed it, or it is still going. A death seen held (a pane, the broker, the registry) even once is `skipped`: that run, not this death, ends it |
| `confirming` | seen dead in fewer than 2 looks at least 60 s apart |
| `dead` | none of the above: revive |

Herdr's recovery window: a Herdr restart ends every pane's pi, the launcher's included, so a launcher that is alive in the same process has seen no restart since the run died; a pi a restore started on the file is `live` (a pane runs it).

## 3. The revive

1. The launch command is the last line of the newest script in `artifacts/<launcher>/subagent-scripts/` whose `# Session:` header names the file (a first launch, or a `-resume-` one). It must start with `cd '<folder>' && ` and end with `'@<task file>'; echo '__SUBAGENT_DONE_'$?'__'`, as maestro's `buildPiCommand` writes it; anything else is `refused`, since editing an unknown command is a guess. A first launch whose task is inline (a fork run, maestro's `taskDelivery: "direct"`) is refused: kept, the revived pi would start the task over. A resume script, which ends in its `-e` entry, takes the notice appended.
2. An entry `{workerRevive: {death, file, step: "reviving"}}` goes into the launcher's session first, keyed by the id of the failure's own entry: a death is acted on once, whatever happens next, even across a reload.
3. `herdr pane split <launcher pane> --direction right --cwd <folder> --no-focus`, then `herdr pane rename` to the run's name, and a second `reviving` entry records the pane, so a reload can close it.
4. The look checks once more that no pane runs the file, the broker does not list it, pi-herdr-agents does not track the run's id, and no newer launch or resume script names the file (a `subagent_resume` the model issued since the look); a hit closes the pane and marks the death `skipped`. A session stopping (a reload) closes the pane before anything is typed. Then it then writes `artifacts/<launcher>/straw-boss-revive/<name>-<time>.md` (the revive notice) and `<name>-<id>-<time>.sh`: the launch command with the task argument replaced by `'@<notice>'` and `PI_SUBAGENT_SURFACE` by the new pane, and types `bash '<script>'` into the new pane.
5. It waits up to 60 s for Herdr to list the pane running pi on the file. Then the step becomes `revived` (with the pane), the launcher's model gets one line, and the boss a notification. Otherwise the pane is closed, the step is `failed`, and the launcher's model is told to resume or respawn it.

The revive notice says when and how the pi died, that its launcher waits for its report, what its last turn was (cut.ts), to check the state before re-running anything that changes it, and to finish the task and report.

## 4. The result

Each look reads the `revived` runs. A run whose `.exit` appeared, with a `type` (one read mid-write waits for the next look), is delivered: the step becomes `delivered` first, then the launcher's model gets the run's last message, encoded as inherit.ts does (every line prefixed, controls written out, 16,000 characters at most), or its error, or its question with the `subagent_resume` arguments to answer it; the `.exit` is removed, as pi-herdr-agents' watcher consumes it, and the pane is closed once pi has left it. A run whose pi is gone with no `.exit`, in two looks 60 s apart, ended again: the step becomes `failed` and the launcher is told with its last message; it is not revived again.

A reload rebuilds all of this from the entries. A step left at `reviving` (the reload came during the start) is `revived` when a pane runs the file; when none does 60 s after the step was written, the pane it records is closed and the step is `failed`.

A superseded death (a later result or ping, a newer script) is skipped with no word to the launcher's model: whoever runs it, or ran it, reports. A refusal found only at a look (the session file gone, say) after the failure carried the paragraph that promised a revive is told to the launcher's model with a turn, since the paragraph said Straw Boss would say so there.

## 5. Limits

- A nested subagent (a subagent's own subagent) is not revived: a subagent runs no Straw Boss session.
- A persistent specialist is not revived (W4).
- The worker cap (workercap.ts) counts pi-herdr-agents' registry, which no longer holds a revived run.
- A managed worktree's manifest keeps the state pi-herdr-agents wrote at the death (`failed`); the revived run's own report is what counts.
- A pane closed on purpose (the boss, an agent, a closed tab) is never revived (review RV-F003, 2026-11-24): the launcher acts on the failure itself. A pi that crashes in a pane whose shell then also dies gives the same text and is not revived either.
- If a launcher's pi-herdr-agents delivered the failure just before a Herdr restart, and the restore started a plain pi on the run's file, the run stays `live` and is not revived; restored.ts does not take it either, since a result names the file.
- Mac sleep is not a death; a reboot ends the launcher as well (a revived main picks up its subagents, inherit.ts).

## 6. Checks

`tests/childrevive.test.ts`: the death table, the two looks, every refusal, the revive's script and pane, the line, the delivery and its encoding, a second death, a failed start, a reload in between, and the paragraph added to the failure. Live: a launcher pi in a scratch folder under the worktree launches a trivial worker, its pi is killed with `kill -9`, and the worker comes back and its report reaches the launcher.
