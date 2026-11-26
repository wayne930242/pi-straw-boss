# Ally workers

Status: implemented on `feat/ally-workers` (unreleased). Boss decisions 2026-11-26: 「照建議全部做」 for every default below; points 「不設下限」.

## Problem

A controller main on the Mac could only reach a teammate's box through an ally run, which opened a main there, which dispatched `subagent` workers. Every hop was a model: the opened main went idle after one round, the model and the worktree were held only by its prompt, one opened main per sender per workspace put every ticket through it in turn, and a result reached the controller through two LLM hops. When box 2's Claude quota ran out, all its lanes stopped unseen.

## Decision

A **worker** is a main of kind `worker` that the box tower opens for its `dispatch` controller, in a worktree of its own, on a model from an allowlist, counted in the box's capacity and board. Code decides each step that must be exact: the slip, the allowlist, the branch and base, the points, and the relay of the result. One model hop is left: the box's ally run, which calls `boss_open_main` `role: "worker"`.

Rejected: the sb server launching pi-herdr-agents children itself (it is no pi; the registry, the result handover and the worktree provisioning are another repository's internals; such a child would be invisible to the capacity facts, revoke, and close-main). Rejected as well: keeping the opened main that dispatches subagents (the problem above).

## Controller side

- `call_tower({ message, worker: { device, branch, base?, model?, points?, label? } })` (`src/link/waitcall.ts`). The slip and the brief are checked on the Mac first (`src/workerslip.ts`), then the `worker-send` op (`src/server/linkwaitsops.ts`) runs the checks of `standing-send` (a main of this computer, no worker itself; an opened main reaches only its opener) and `src/server/workersend.ts` sends it.
- The first line is written by code: `worker: <label> | branch: <b> | base: <ref> | model: <id> | points: <n>`; the brief follows unchanged. It goes as the workspace's tower identity, a plain `tower` with an ask for the main, so straw-relay needs no new kind.
- It fails fast unless the box's fresh caps list `tower.worker`. A box lists it when it has a wait router, a `workers` section, and a `capacity.budget` in `config.json`.
- The ask lives 7 days (`WORKER_ASK_KEEP_MS`), as long as the worker's route on the box.

Every outcome is a `tower-reply` to that ask and reaches the main by session id as a `link_reply`.

| Outcome | Who answers |
|---|---|
| Refusal or failed open (config, budget, model, route cap, branch, base, pi did not start) | the box server's door, by code |
| Done or blocked | the worker's first `call_tower` `why: milestone`, relayed by code |
| Pi gone (two sweeps in a row) | a code receipt: branch, head, what became of the worktree |
| Idle 60 minutes with no report | a code receipt; the worker is interrupted and its worktree kept |
| Revoke | none: the device is gone; the admin notices stand |

## Box side

- **The door** (`src/server/runtools.ts`): `boss_open_main` `role: "worker"` only in an ally run at `dispatch`, for the run's own `link:` sender, refused before the gate. The slip is read from the run's taken messages (`allyMessages`), never from the model's arguments; `branch` picks one when several came. A local run's `role: "worker"` is refused.
- **The open** (`src/server/workerally.ts`, `workerwire.ts`, `workeropen.ts`), one at a time per state folder: config, model allowlist (`workers.models`, exact ids; an omitted model is pi's default), route cap, project binding (`within`), then admission against `capacity.budget` on any device, attended or not: a `self` reservation under `capacity/_reserved`, written before the row is read (`admitPoints`, shared with a main's `subagent` admission) and claimed with the new session once the open returns. Then `git fetch origin` and `git worktree add` into `~/.herdr/worktrees/<repo>/<branch, / as ->`, which must not exist.
- **Branch and base.** The branch matches `^[A-Za-z0-9._/-]{1,100}$`, passes `git check-ref-format --branch`, and is none of `main`, `master`, `develop`, `HEAD`, `release/*`, `pre-dev/*`, `train-*`, `train/*`, `agent-train/*`, or an app's `integration.base` in apps.json. With `origin/<branch>` the worktree starts there (a rework); a local branch origin lacks, or one that differs from origin's, is refused. Otherwise the base is `origin/<base>`, a 40-hex commit, or origin's default branch. Git runs with no shell, argument lists, `--`, `GIT_TERMINAL_PROMPT=0`, and timeouts.
- **The tab** (`src/opener.ts`): `role: "worker"` needs the peer and the prepared worktree. The tab's folder is the worktree, `assertSettingsSafe` runs on it, pi starts with `--model`, and the pane gets `sb_open_duty=worker`. A worker counts toward neither the two opened mains of a workspace nor its sender's one, and the witness is the route table (`workerPanes`), not a pane token. Worker opens keep no ledger row, so a refused or failed slip may be sent again. A failed open removes the worktree and the branch it made.
- **The kind** (`src/duty.ts`): `worker` is a main kind (`MainKind`), taken at the claim only for a pane opened by a `link:` sender. It is no coordinator kind, so the page and the sidebar draw it as a plain main (a worker kind draws on a subagent only), and the `worker` parameter of `call_tower` is offered only where Straw Link is set up. Its prompt is `prompts/worker.md` alone (the rules of every turn); the moment's rules are in its handoff (`src/workerhandoff.ts`). `boss_duty` refuses a switch to or from it, `boss_wrap` refuses it, and it may start no `worker` subagent (scouts and reviewers may help).
- **Capacity** (`src/capacity.ts`): a worker main's row counts its own points (from its route, `workerPointsOf`), lists itself as a unit, and has no ready work, so its own steps raise no `under` alarm.
- **Routes** (`src/server/allyroute.ts`): a worker's `opened` row keeps `worker { points, branch, path, base, baseSha, label }` and `final`. The caps are 24 rows per device and 40 in all, and only rows of mains the broker no longer lists are trimmed; a live row never is, and a worker's open at the cap is refused (`openedRoom`).

## Relay and end

- `src/server/workerrelay.ts` `workerReport`, hooked where an opened main's reports arrive in `towers.ts`: a worker route, no `final` yet, and a code-written header `kind=call_tower why=milestone` make the code send the body to `route.ask` as a `tower-reply`, drop the ask, and set `final`. A send that fails, or a route with no ask, falls back to the ally answer of before.
- `createWorkerEnds`, swept with the revoker: a final row is quit, and its worktree removed when clean and its HEAD is on `origin/<branch>` or still the base, else kept with a notice to the workspace's tower. A worker gone two sweeps in a row gets a receipt. One idle 60 minutes (`WORKER_STOP_MS`, the server's own clock of its pane's state) is interrupted, answered with a receipt, and marked so the next sweep closes it.
- The worker's own nudge (`WORKER_NUDGE`, `src/wrapup.ts`): idle 15 minutes with nothing running, once per idle period, under auto mode too.
- `revoke.ts` ends a worker row with `interrupt`.

## Security

`dispatch` already grants an opened main every right of a main on peer text. What a worker adds, and the check on each:

| Adds | Check |
|---|---|
| Parallel sessions | the capacity budget, required; the route cap, never trimming a live row |
| A model on the box's accounts | exact match against `workers.models` and an id pattern |
| Git the server runs on peer strings | the branch and base rules, a path built inside `~/.herdr/worktrees`, no shell, `--`, timeouts, fetch from `origin` only |
| A base the peer chooses, which could carry `.pi/settings.json` | `assertSettingsSafe` on the worktree before pi starts, and the trust wait as for any open |

Points are server-held and clamped to 0.25–10. A controller can still under-declare them; by the boss's decision there is no minimum beyond the clamp.

## Resume

Added 2026-11-26 (design approved by the boss: the full session id only, `tower.worker.resume`, refuse a live worker, 7 days, refuse an off-list recorded model unless one is given, no cap beyond capacity).

- **Controller.** The final report, the gone receipt, and the idle receipt end with a code-written `Session: <uuid> · resume: …` line. `call_tower` `worker {device, resume: "<uuid>", branch?, model?, points?}` writes `worker: <label> | resume: <uuid> [| branch: <b>] [| model: <id>] [| points: <n>]` over the follow-up. Nothing goes when the target's caps lack `tower.worker.resume` (an older box would refuse the unknown key without a cause), the id is no full lowercase uuid, `base` is given, or the message is empty.
- **Caps.** `hello` goes first in a `caps`, and new decoders keep 32 features: a decoder that keeps 16 still sees `hello` and every feature it knows.
- **Book.** `workers-opened.json` keeps one entry per session: the ask (earlier asks in `prior`), the device it is bound to, team, workspace, branch, label, path, base, base sha, points, model, the session file (Herdr's `agent_session`, read at the open and at each sweep look), the last head, and how and when it ended. Kept 7 days after its last mark; each end and each resume renews it. It authorises nothing alone.
- **Door** (`server/workerresume.ts`, on the opens' queue): the config, hold, budget, and route cap; the entry of (the run's own device, session), else the unknown-id text, which lists up to 5 of that device's resumable sessions; no live route of the session (`still runs`) and none final or listed by the broker (`closing`); the worktree derived again from the repository and branch, which must equal the file header's `cwd` and must be held by no other live worker; the model (an override on the allowlist, else the recorded one still on it); admission with the slip's or the recorded points; an existing worktree must be this repository's on that branch and is reused, a gone one is made again by `prepareWorktree` from `origin/<branch>` or the recorded base; then `fileRefusal` with the worktree as checkout. The opener starts `pi --session <file>` (no `--name`, `--model` only when given) after `assertSettingsSafe`, waits for that session id, refuses a twin pane on the file, and hands over `workerResumeHandoff`. A new route row answers the new ask. On failure the tab closes, a worktree this resume made goes, and the reservation is freed; every refusal answers the ask as `The box did not resume worker <label> (session <id8>, branch <b>): <cause>`.
- Departure: the door checks the model and the budget before it makes the worktree, so a refusal there leaves no worktree to drop.

## Departures from the design

- The `done` close and the crash and idle receipts live in `createWorkerEnds` (`workerrelay.ts`) beside the revoker, not as new reasons inside `revoke.ts`; `revoke.ts` only gained `interrupt` for workers. That keeps the revoker's notices and its two-sweep rule unchanged.
- A worker's open asks no confirm and keeps no ledger row; the worktree path that must not exist is what stops a second open of the same branch.
- The idle clock of the 60-minute stop is the server's memory of the pane's state, so a server restart starts it again (later, never earlier).
- A worktree kept at close is told to the workspace's tower as a run notice, not to the standing main.

## Not covered

The ally run on the box stays the one model hop. A code path that opens a `dispatch`-level worker slip with no ally run would remove it, but it changes the queue-and-claim flow.
