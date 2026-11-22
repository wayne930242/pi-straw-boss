# The tower revives a dead main, and a main opens its own successor (2026-11-23)

Status: implemented on `feat/tower-revive` (base `main` 63384d92, 0.81.7), for 0.82.0. The plan it follows was `/tmp/revive-orphans-plan.md` (not kept in the repository); this record replaces it. How it behaves for a user: [how-it-works, Reviving a dead main](../how-it-works.md#reviving-a-dead-main), [A revived main picks up its subagents](../how-it-works.md#a-revived-main-picks-up-its-subagents), and [A main's own handover](../how-it-works.md#a-mains-own-handover).

## Boss words (binding)

> 「請派工 sb 0.81.3 那邊，讓他有能力救活死掉的 main agent，也讓 main agent 有能力 pick 孤兒 sub agent」, then 「是要讓塔台救」.

> 「他的 agent type 也得一併回覆…也要回覆他在 sb 的 role」

> 「main agent 現在的交接都要叫我 /new，明明就有 herdr cli 可以用」

## Decisions (boss, 2026-11-23)

| # | Question | Decision |
|---|---|---|
| D1 | Who acts on a detected death | **A**: the code detects a death, and a tower run decides with `boss_revive_main`. |
| D2, D7 | Orphan pickup, finished results | **O1**: the revived main inherits its own orphans. sb delivers done and ping results itself, encoded. Only cut runs are resumed. |
| D3 | The old tab | **B**: open a new tab. Close the old tab only when the tower opened it and its sole pane is the dead pane at a bare shell (`process-info` proof). |
| D4 | Mains a teammate's device opened | Refused in v1. |
| D5 | Members | Refused in v1. |
| D6 | Trains | Not refused: trains are revived in this release (P4). |
| Scope | | P0 to P4 plus docs. P5 (a tower hands orphans to another main, `/boss revive`) is out. |
| Identity | | A revive restores the whole sb identity, not only the pi session: role, kind, name, board, todos, train record, and the waits and routes it held. A role that cannot be restored is refused, with the reason. |
| Handover | | A main that rotates its session opens its successor itself through sb's opener: a new tab in the same workspace, pi started with the handoff path as its first prompt, under the old main's kind and name. No `/new`, no boss action. |

## 1. P0: what each ending leaves

Probed on 2026-11-23 with five scratch pis in workspace `w337` of the default Herdr (tabs t2 to t6), each running an extension that logs `session_start`, `session_shutdown` with its reason, and the process signals it sees (`/tmp/sbprobe/log.jsonl`):

| Ending | `session_shutdown` | Signal seen | What it looks like |
|---|---|---|---|
| `herdr pane close` | none | none | a crash |
| `herdr tab close` | none | none | a crash |
| `kill -9` | none | none | a crash |
| `kill -TERM` | `reason: "quit"` | SIGTERM, just before | a quit, told apart by the signal |
| `/quit` typed | `reason: "quit"` | none | a quit |

So a pane or tab closed in Herdr does not look like a quit: Herdr kills the pane's processes and pi runs no shutdown. The probe closed them with the CLI, which is the server call the UI's close makes; the UI's close button was not pressed separately. A crash, a kill, and a Herdr close are therefore one state (`dead`), and the run decides (D1), since a pane the boss closed by hand looks the same. A signal is told from a typed quit by a listener added after pi's own (`src/signalseen.ts`): the mark says `signal`.

**The ended mark.** `src/roles.ts` writes `ended: {at, reason}` into the session's own role record at a shutdown that is no close on purpose and no `/reload`: `quit`, `new`, `resume`, `fork`, or `signal`. A close on purpose forgets the record as before. `roles.held` ignores the mark, so a Herdr restore brings the session back whatever it says; a later start clears it.

## 2. Dead or ended: one table

`src/dead.ts` decides each role record from one table, as `typegate.ts` does for typing, from the record, its session file, Herdr's panes, the broker's sessions, and Herdr's recovery window:

| State | Evidence |
|---|---|
| `closed` | no record: a close on purpose forgot it |
| `invalid` | the record's file fails the checks of §5 |
| `live` | a pane runs the file, the broker lists its id, or the file moved in the last 60 s; it wins over every mark |
| `quit` | the record carries `ended` |
| `stale` | the file has not moved for 24 h |
| `restoring` | Herdr's recovery window is open, or the death was seen in fewer than 2 looks 60 s apart |
| `dead` | none of the above |

## 3. Detection and the `main_died` notice

The sb server's tower (`src/server/deadwatch.ts`, on the server's refresh timer) sweeps each workspace it serves once a minute. A main or train found `dead` in two looks at least 60 s apart, outside the recovery window, becomes one `main_died` event on that workspace's tower queue, keyed by the death (the file's size and mtime when found), so a death raises once. The text is code-written: the main, its kind, tab, board line, file age, the sender that opened it, and its subagents by class. A main that dies within 10 minutes of a revive is listed and not raised (the crash-loop guard of §5).

The run's brief (`towerbrief.ts`) lists the workspace's dead and quit mains under "Mains that ended without a close". `boss_open_main` for a sender whose own opened main died adds a note that the dead main can be revived once this one closes, since a sender gets one opened main at a time. A `tower_reply` to a dead main fails as before, and its text is kept in the revive ledger for the revive's handoff ("missed deliveries"); the run is told it was kept.

A pi tower gets the tool and the brief, not the sweep: the server's tower owns detection.

## 4. `boss_revive_main` and the identity it restores

`boss_revive_main {action: "list" | "revive", session?, reason}`, in `src/revive.ts` (the records, the checks, the texts) and `src/reviver.ts` (the steps). `session` is an id, an id prefix of 8 or more characters, or a name; `reason` is one line of up to 300 characters.

| Who | Has it |
|---|---|
| a local tower run of the sb server | yes (`runtools.ts`, `runallow.ts`, `runmode.ts`) |
| a pi tower session | yes, and it is in `PARENT_ONLY` |
| an ally run, the head tower | no; an ally run is refused by its kind |
| a main, a member | no |

At `dispatch` a run calls it without a confirm, as it calls `boss_open_main`.

**Steps.** Revives and opens share the opener's queue, and a `wx` lock in `<state>/revive/` keeps a pi tower and the server's tower off one file at once.

1. Re-read the record and the panes and refuse as in §5.
2. Create a tab in the record's workspace, cwd the session header's folder, label `tabLabel(name)` (a train: `trainLabel(code)`), env `STRAW_BOSS_ROLE=main` (`train` for a train).
3. Write the tokens: `sb_open_main=1`, `sb_revive=<key of the file>`, the record's `sb_opened_by`, a train's `sb_train`, and the record's kind as `sb_open_duty` when the session's entries hold none (the entries win).
4. Check once more that no pane runs the file, then start `pi --session <file>` with no `--name`: pi restores its own name.
5. Wait up to 60 s for the pane's `sb_role` and for the broker to list the dead session's own id there. Another id is a failure, and the tab closes.
6. If another pane runs the file by then (a Herdr restore or a manual `pi --session` raced it), close the revived pi's tab and refuse: that one keeps it.
7. Send the handoff (`reviveHandoff`): code-written facts only. When and how it ended, which tower revived it and why, what came back and what did not (monitors, loops, watches, subagent watchers), what to do now in order, the link waits and wait cards it holds, and the missed deliveries.
8. D3: close the old tab only when its pane carried `sb_opened_by` (a tower opened it), the tab has that one pane, and `herdr pane process-info` lists a shell alone. Every other old tab stays.
9. Record the try and its outcome in `<state>/revive/<key>.json`.

**Identity, per part.** The pi session id is the intercom id (pi-intercom `config.stableId || piSessionId`, and `pi --session` keeps it), so everything keyed by it finds the revived main with no copy.

| Part | Where it lives | On revive |
|---|---|---|
| role main | role record `role: "main"` | `STRAW_BOSS_ROLE=main` and the `sb_open_main` claim; `roles.remember` rewrites the record for the new pane and tab |
| kind | session entry `straw-boss {duty}`, record `duty` | the entries; the record's kind as `sb_open_duty` for a session with none |
| name | pi's `session_info` | restored by pi under `--session`; the tab is labelled with it |
| opener, sender | record `openedBy`, session entry | the `sb_opened_by` token, so `boss_close_main` and the caps act as before |
| board row | `board/<id>.json`, purged 24 h after its last update | same id: the revived main's row again, refilled from its todos |
| todos | the session branch | automatic |
| expected replies | `towers/<ws>/expects.json` by id | automatic |
| link waits held | `linkwaits` `toldTo`/`claimedBy` by id or name | automatic; the handoff lists them |
| wait cards it raised | tower memory, raiser by id | automatic; the handoff lists the open ones and names a boss press whose notice did not reach it |
| integrator | kind `integrator`, name `integ <project>`, record `openedBy = integ:<project>` | as a main |
| train (P4) | record `role: "train", train: {project, code}`, its trainboard | `STRAW_BOSS_ROLE=train`, `sb_train`, the code label; the opener's "a code is used once" rule is set aside on this path only |
| subagents | the session's artifacts folder | §6 |

**What each role restores or refuses.**

| Role | Outcome |
|---|---|
| main of kind coordinator or standing, opened by the boss | revived; counts toward no cap |
| main opened by a tower for a sender | revived, its `sb_opened_by` back, so it takes its cap place back |
| integrator | revived as itself; refused while integration is off or its project has a live integrator ("a project has one") |
| train | revived when its trainboard is under way (no `end.json`, not ended), its writer is this session and its pid is gone, no live pane carries its code, and integration is on; each other case refused with its reason |
| main opened for a teammate's device (`link:<device>`) | refused (D4): its route lapsed after 10 min and the device's trust may have changed; the device asks again |
| member | refused (D5): it has no role record and holds nothing a tower restores; resume it with `pi --session` |
| tower | refused: it comes back by itself (the server adopts its service; the guard opens a pi tower) |

A `quit` main may be revived, but the prompts say only when a request names it.

## 5. Limits and refusals

Each refusal is a `ReviveRefused` (an `OpenLimitError`) whose message the run relays, and creates nothing.

- **The file** (`fileRefusal`): a regular file (`lstat`, no link) under pi's sessions folder; pi's header with `type: "session"` and an id equal to the id in the file name (a differing id means `PI_INTERCOM_STABLE_ID` or a renamed file, so nothing it held would find it); no `.pi-herdr-subagent-policy.json` sidecar; the header's cwd inside the workspace's checkout.
- **The workspace**: only the record's workspace's tower revives it.
- **A live holder**: a pane runs the file, the broker lists the id, or the file moved in the last 60 s; checked at step 1, again before `startPi`, and after it (step 6).
- **Once per death**: a death tried once is refused, failed or not; the boss decides a retry.
- **Crash loop**: at most 2 revives of one file in 24 h, and none raised unasked within 10 minutes of a revive.
- **Caps**: a tower-opened main is refused while its sender has another opened main live, or while the workspace has 2 tower-opened mains. A boss-opened main counts toward neither.
- **The role**: as the table of §4.

## 6. The revived main picks up its orphans (O1)

The revived main runs the same session file, so pi-herdr-agents' artifacts folder (`subagent-activity/`, `subagent-scripts/`, `worktree-runs/`) is its own: nothing is re-parented. `src/inherit.ts` runs at the claim that carried `sb_revive` and at each start after it, over every run in `subagent-activity/` that pi-herdr-agents does not track (its registry) and whose `subagent_result` or `subagent_ping` is not in the transcript. It hands the model one steering message, `straw-boss-orphan-result`:

| Class | Evidence | What it gets |
|---|---|---|
| finished | `<child>.exit` says `done` or `error` | the child's last assistant message, read by sb, at most 16,000 characters, each line prefixed with `| ` and controls and invisible characters written out, so child text cannot pass for host lines |
| help request | `.exit` says `ping` | its message, framed the same way, with the `subagent_resume` arguments |
| cut | no `.exit`, no pane runs it | listed for `subagent_resume` with its path, name, and follow-up, and what its transcript says of its last turn (D7: only these are resumed) |
| running | its pane runs its launch script | watched; delivered as above when its `.exit` appears |
| idle | waiting at its prompt | left to `orphan.ts`, which asks it once to report |
| managed worktree, persistent specialist | manifest, `PI_SUBAGENT_PERSISTENT=1` | listed, never resumed (pi-herdr-agents refuses both) |

Each run is told once: a `straw-boss` entry with an `inherited` key is written before the message, and `orphan.ts` and `restored.ts` read the same done set, so nothing repeats after a `/reload` and a tracked id is skipped (an upstream watcher rehydration would take over with no flag). `.exit` is left on disk.

**The `subagent_resume` guard.** sb's `tool_call` hook refuses `subagent_resume` for a `sessionPath` a live pane runs, in any session: two pis on one file would corrupt it. pi-herdr-agents checks neither the owner nor a live file, so this closes that gap too.

No pi-herdr-agents change was made.

## 7. Security and races

| Risk | Handling |
|---|---|
| Two towers revive one file | the record's workspace only; the opener queue; the cross-process lock; once per death |
| A revive races a Herdr restore or a manual `pi --session` | `restoring`, two looks, the checks before and after the start; the other pi keeps the file |
| The boss closed the tab on purpose | not acted on by code: a run decides, and its handoff note says why; a revived main can be closed again |
| Crash loop | §5 |
| A forged role record (a same-user process can write `roles/`) | the record is a claim, checked against the file, its header, its sidecar, its cwd, the workspace, and the live panes; a same-user process can already run `pi --session` itself |
| Remote turns | ally runs get neither the tool, the event, nor the brief section; link-opened mains are refused; `main_died` never leaves the computer; the handoff and the pickup carry code text and framed child text only |

## 8. A main opens its own successor

`boss_handover {handoff, reason}` (`src/tools.ts`, `openSuccessor` in `src/reviver.ts`), a joined main's tool, listed in `PARENT_ONLY`.

- Refused in a teammate's turn, for a tower, a train ("a train ends with its milestone report"), and a member; `reason` is one line of up to 200 characters; the handoff file must be a regular file; a main whose name is a role label renames first.
- One live successor: the successor's pane is kept in the session (`straw-boss {successor}`), and a second call while that pane runs an agent is refused.
- It goes through the opener's safe start: the settings check of the main's folder, a new unfocused tab labelled with the main's name, `STRAW_BOSS_ROLE=main` with `sb_open_main`, the main's own `sb_opened_by` and kind (`sb_open_duty`), `sb_handover_from=<old id>`, and pi started with `--name <old name>`.
- Once the new pi is the tab's main it gets one message: read the handoff and follow the session-rotation rule; its kind is set already; tell the old main by intercom that it took over. The old main's result tells it how to step down: `boss_duty coordinator` (when standing or integrator), `boss_rename` to `old <name> (handed over to <id>)`, monitors and loops stopped, board cleared, then wait to be closed.
- A failure closes the tab it made.

The main prompt has no rotation line, so none was changed; the tool's description carries the instruction, and `main.md` stays within its character cap (`tests/duty-prompts.test.ts`). The rule lives in weihung-basic-agent `rules/session-rotation.md`, outside this repository.

## 9. Prompts

`tower.md` gains one line (a dead main whose work is not done comes back with `boss_revive_main`; no new main for its sender) and `tower-run.md` one (act on `main_died`; leave a main the boss closed on purpose or whose work ended, and say which; a `quit` main only when a request names it). Budgets, measured: `tower.md` on 487 to 508, off 417 to 438 (`tests/prompts.test.ts`, dated 2026-11-23).

## 10. Tests

| Phase | Tests |
|---|---|
| P0, P1 | `tests/dead.test.ts` (the table, live over every mark); `tests/deadwatch.test.ts` (one notice per death after two looks; none in the recovery window; a quit, a live pane, a member, a death within 10 min of a revive raise nothing); `tests/revive.test.ts` (the ended mark per reason) |
| P2 | `tests/revive.test.ts` (the revive's tab, tokens, `--session` with no `--name`, the same id, the handoff, the ledger, `board_read` live with the kind; each refusal; once per death; D3 both ways; an ally run has no tool); `tests/revive-server.test.ts` (a local run lists and revives; an ally run is refused by kind; a `tower_reply` to a dead main is kept) |
| P3 | `tests/inherit.test.ts` (each class, the `.exit` watch, no repeat after `/reload`); `tests/revive.test.ts` (pickup at the claim; the `subagent_resume` guard) |
| P4 | `tests/revive.test.ts` (a train comes back as itself; an ended train, a live writer, and a pane with its code are refused) |
| Handover | `tests/handover-main.test.ts` (one successor tab with the name, kind, and handoff prompt; a second while it lives is refused; a member, a missing file, a tower, and a remote turn are refused) |

Each was written red first and seen red against the code it pins.

## 11. Out, and open

- P5: a tower hands a dead main's orphans to another main (O2), and `/boss revive` for the boss.
- An upstream pi-herdr-agents watcher rehydration; sb steps aside on its own when it lands, since those ids are tracked again.
- The live check of the plan (kill -9 a tower-opened main with two workers in scratch workspaces, revive, both results arrive) was not run by the build; it belongs to the release's live check.
